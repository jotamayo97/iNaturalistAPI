/* eslint-disable no-console */
/* eslint-disable class-methods-use-this */
const _ = require( "lodash" );
const fs = require( "fs" );
const path = require( "path" );
const squel = require( "squel" );
const moment = require( "moment" );
const stream = require( "stream" );
const { promisify } = require( "util" );
const { once } = require( "events" );
const PromisePool = require( "es6-promise-pool" );
const Pool = require( "./pg_pool" );
const Taxon = require( "./models/taxon" );
global.config = require( "../config" );

const fsPromises = fs.promises;

const finished = promisify( stream.finished );

// how many taxa to process at one time
const TAXA_CONCURRENCY = 5;
// how many sets of observations, per-taxon, to lookup at one time
const OBSERVATIONS_CONCURRENCY = 2;

// Some rules/assumptions:
//   Never use taxa/clades which are known to be globally extinct
//   Never use taxa below species
//   Never use taxa/clades with rank hybrid or genushybrid
//   Never use inactive taxa
//   Only consider observations whose observation_photos_count is greater than 0
//   Never use leaf taxa whose observations_count is less than 50
//   Never use observations that have unresolved flags
//   Never use observations that fail quality metrics other than wild
//   Never use photos that have unresolved flags
//   Populating files:
//     Test and Val must have observations whose community_taxon_id matches the clade
//     Train can also use obs where just taxon_id matches the clade, as lower priority
//     One photo per obs in test and val, train can use 5 per obs
//     In train, start adding one photo per observation, and fill with additional 4 if there's room
//     If obs photos are used in any set, the other obs photos cannot appear in other sets
//       Ideally if obs in train, not represennted in other sets. Not too bad if obs in val and test

// Data to include in export in the future:
//   wether or not community_id is a match

// Future stuff:
//   limits are configurable at clade

const VisionDataExporter = class ExportVisionNew {
  /* eslint-disable lines-between-class-members */
  static TRAIN_MIN = 50;
  static TRAIN_MAX = 1000;
  static TEST_MIN = 25;
  static TEST_MAX = 100;
  static VAL_MIN = 25;
  static VAL_MAX = 100;
  static SPATIAL_MAX = 5000;
  static TRAIN_PHOTOS_PER_OBSERVATION = 5;
  /* eslint-enable lines-between-class-members */

  constructor( options = { } ) {
    console.log( options );
    this.selectTaxonIDs = options.taxa || [];
    this.customLeafTaxonIDs = options.leaves || [];
    this.trainMin = options["train-min"] || VisionDataExporter.TRAIN_MIN;
    this.trainMax = options["train-max"] || VisionDataExporter.TRAIN_MAX;
    this.valMin = options["val-min"] || VisionDataExporter.TEST_MIN;
    this.valMax = options["val-max"] || VisionDataExporter.TEST_MAX;
    this.testMin = options["test-min"] || VisionDataExporter.VAL_MIN;
    this.testMax = options["test-max"] || VisionDataExporter.VAL_MAX;
    this.spatialMax = options["spatial-max"] || VisionDataExporter.SPATIAL_MAX;
    this.trainPhotosPerObservation = options["train-per-obs"] || VisionDataExporter.TRAIN_PHOTOS_PER_OBSERVATION;
    this.runOptions = options;
    this.taxonData = { };
    this.taxonChildren = { };
    this.taxonNames = { };
  }

  async initialize( ) {
    const startID = 0;
    const maxID = await ExportVisionNew.maxTaxonID( );
    const batchSize = 1000;

    await this.createOutputDir( );
    await this.createCSVFiles( );

    // await this.lookupFilePrefixes( );
    // await this.lookupFileExtensions( );
    await this.lookupGloballyExtinctTaxonIDs( );
    await this.parallelProcess( this.taxaProcessor, startID, maxID, batchSize, TAXA_CONCURRENCY );
    this.leafTaxaNeedingProcessing = [];
    const unnamedTaxonIDs = _.map( _.filter( this.taxonData, t => !_.has( t, "name" ) ), "id" );
    await this.taxaLeftoverProcessor( unnamedTaxonIDs );

    const selectTaxonAncestries = _.compact( _.map( this.selectTaxonIDs, id => (
      this.taxonData[id] ? this.taxonAncestry( this.taxonData[id] ) : null
    ) ) );
    this.selectTaxonAncestors = _.map( _.uniq( _.flatten( _.map(
      selectTaxonAncestries, a => a.split( "/" )
    ) ) ), Number );

    this.taxonLeafClasses = { };
    this.taxonIconicClasses = { };
    this.leafClassIndex = 0;
    this.iconicClassIndex = 0;

    await this.processEntireTree( );
    await this.printTree( );
    await this.printStats( );

    await this.forEachInSequence( _.keys( this.taxonIconicClasses ), async iconicTaxonID => {
      const taxon = this.taxonData[iconicTaxonID];
      const iconicFileFields = [
        iconicTaxonID,
        this.taxonIconicClasses[iconicTaxonID],
        taxon ? taxon.name : "Unassigned"
      ];
      await this.writeToFile( this.iconicFileStream, iconicFileFields.join( "," ) );
    } );

    await this.closeOutputFiles( );
  }

  async closeOutputFiles( ) {
    this.trainFileStream.end( );
    await finished( this.trainFileStream );
    this.testFileStream.end( );
    await finished( this.testFileStream );
    this.valFileStream.end( );
    await finished( this.valFileStream );
    this.spatialFileStream.end( );
    await finished( this.spatialFileStream );
    this.taxonomyFileStream.end( );
    await finished( this.taxonomyFileStream );
    this.iconicFileStream.end( );
    await finished( this.iconicFileStream );
  }

  //
  // main loop for fetching data for the export. Traverse depth-first through all
  // potentially eligible taxa, populating an array of taxa that need to be looked
  // up next., then processing any taxa that need processing that pass. Finishes
  // once all the root taxa have been processed
  //
  async processEntireTree( ) {
    this.depthFirstTraverse( );
    await this.processTaxaStack( );
    // all root taxa have been processed, so no need for another pass
    // NOTE: it is not safe to assume that if the process stack is empty then the
    // entire tree has been processed. Only when the roots have been processed is it done
    if ( _.every( _.keys( this.taxonChildren[0] ), rootID => this.taxonData[rootID].status ) ) {
      return;
    }
    await this.processEntireTree( );
  }

  //
  // process any taxa that need processing after the last depth-first pass
  //
  async processTaxaStack( concurrency = TAXA_CONCURRENCY ) {
    this.counter = 0;
    this.total = _.size( this.leafTaxaNeedingProcessing );
    this.leafTaxaNeedingProcessing = _.shuffle( this.leafTaxaNeedingProcessing );
    const promiseProducer = ( ) => {
      const lookupTaxon = this.leafTaxaNeedingProcessing.shift( );
      return lookupTaxon ? this.lookupObs( lookupTaxon ) : null;
    };
    this.startTime = Date.now( );
    await this.asyncPromisePool( promiseProducer, concurrency );
  }

  //
  // main method for traversing the taxonomy. This method will look at children
  // of the supplied taxon. If any children need processing, it will run them
  // through this same method. If all children have been processed and any have
  // been fully populated or are complete because decendants are populated or
  // complete, the taxon will be marked as complete. If this is a leaf node in
  // the original taxonomy, or no children have been marked complete or
  // populated, then this is a leaf node in the working taxonomy and it needs to
  // be processed.
  //
  async depthFirstTraverse( taxon = null, spaces = 0, withinFilterBranch = false ) {
    let selectedBranch = false;
    if ( taxon ) {
      this.assessTaxonExtinct( taxon );
      selectedBranch = this.assessWithinFilterBranch( taxon, withinFilterBranch );
      if ( !VisionDataExporter.taxonNeedsProcessing( taxon ) ) { return; }
    }
    const childIDs = taxon ? this.taxonChildren[taxon.id] : this.taxonChildren[0];
    if ( !_.isEmpty( childIDs ) && !( taxon && _.includes( this.customLeafTaxonIDs, taxon.id ) ) ) {
      const children = _.map( _.keys( childIDs ), childID => this.taxonData[childID] );
      const unprocessedChildren = _.filter( children, child => !child.status );
      // if any children haven't not been processed at all, process them
      if ( !_.isEmpty( unprocessedChildren ) ) {
        _.each( unprocessedChildren, child => {
          this.depthFirstTraverse( child, spaces + 1, selectedBranch );
        } );
        return;
      }
      // at this point we know all children have been processed,
      // though some may still be under the photo threshold
      const unskippedChildren = _.filter( children, child => child.status !== "skipped" );
      // if any of the children are directly populated, or complete because decendants are
      // populated or complete, mark this branch as complete and skip it
      if ( _.some( unskippedChildren, child => (
        child.status === "complete" || child.status === "populated"
      ) ) ) {
        taxon.status = "complete";
        return;
      }
    }
    // this is a lowest-level taxon (leaf) in a branch that still needs processing
    if ( taxon ) {
      this.leafTaxaNeedingProcessing.push( taxon );
    }
  }

  async taxaProcessor( startID, endID ) {
    const query = squel.select( )
      .field( "t.id" )
      .field( "t.ancestry" )
      .field( "t.rank" )
      .field( "t.rank_level" )
      .field( "t.name" )
      .field( "t.observations_count" )
      .field( "t.iconic_taxon_id" )
      .from( "taxa t" )
      .where( "t.observations_count >= 50" )
      .where( "t.rank_level >= 10" )
      .where( "t.is_active = ?", true )
      .where( "t.rank != ?", "hybrid" )
      .where( "t.rank != ?", "genushybrid" )
      .where( "t.id > ? and t.id <= ?", startID, endID );
    const { rows } = await Pool.query( query.toString( ) );
    _.each( rows, row => this.taxaPopulate( row ) );
  }

  async taxaLeftoverProcessor( ids ) {
    if ( _.isEmpty( ids ) ) {
      return;
    }
    const query = squel.select( )
      .field( "t.id" )
      .field( "t.ancestry" )
      .field( "t.rank" )
      .field( "t.rank_level" )
      .field( "t.name" )
      .field( "t.observations_count" )
      .field( "t.iconic_taxon_id" )
      .from( "taxa t" )
      .where( "t.id IN ?", ids );
    const { rows } = await Pool.query( query.toString( ) );
    _.each( rows, row => this.taxaPopulate( row ) );
  }

  taxaPopulate( row ) {
    const ancestorIDs = _.isEmpty( row.ancestry ) ? [] : row.ancestry.split( "/" );
    ancestorIDs.push( row.id );
    this.taxonData[row.id] = Object.assign( this.taxonData[row.id] || { }, row );
    this.taxonData[row.id].iconic_taxon_id = this.taxonData[row.id].iconic_taxon_id || 0;
    let lastAncestorID = 0;
    _.each( ancestorIDs, ancestorID => {
      this.taxonChildren[lastAncestorID] = this.taxonChildren[lastAncestorID] || { };
      this.taxonChildren[lastAncestorID][ancestorID] = true;
      if ( this.taxonData[ancestorID]
        && this.taxonData[ancestorID].parentID
        && this.taxonData[ancestorID].parentID !== lastAncestorID
      ) {
        const error = `Ancestry mismatch: ${ancestorID} has parents [${lastAncestorID}, `
          + `${this.taxonData[ancestorID].parentID}] in ancestry of ${row.id}`;
        if ( !this.runOptions["skip-ancestry-mismatch"] ) {
          throw new Error( error );
        } else {
          console.log( error );
        }
      }
      this.taxonData[ancestorID] = this.taxonData[ancestorID] || { };
      this.taxonData[ancestorID].id = Number( ancestorID );
      this.taxonData[ancestorID].parentID = lastAncestorID;
      lastAncestorID = Number( ancestorID );
    } );
  }

  taxonHasMinimumPhotos( taxon ) {
    if ( _.size( this.taxonPhotosWorking[taxon.id].test ) < this.testMin ) { return false; }
    if ( _.size( this.taxonPhotosWorking[taxon.id].val ) < this.valMin ) { return false; }
    if ( _.size( this.taxonPhotosWorking[taxon.id].train ) < this.trainMin ) { return false; }
    return true;
  }

  taxonHasMaximumPhotos( taxon ) {
    if ( _.size( this.taxonPhotosWorking[taxon.id].test ) < this.testMax ) { return false; }
    if ( _.size( this.taxonPhotosWorking[taxon.id].val ) < this.valMax ) { return false; }
    if ( _.size( this.taxonPhotosWorking[taxon.id].train ) < this.trainMax ) { return false; }
    return true;
  }

  taxonHasMaximumSpatial( taxon ) {
    if ( _.size( this.taxonPhotosWorking[taxon.id].obsWithCoords ) < this.spatialMax ) {
      return false;
    }
    return true;
  }

  taxonHasMaximumData( taxon ) {
    if ( !this.taxonHasMaximumPhotos( taxon ) ) { return false; }
    if ( !this.taxonHasMaximumSpatial( taxon ) ) { return false; }
    return true;
  }

  //
  // return IDs of this taxon plus all its descendants
  //
  async lookupTaxonIDs( taxon ) {
    const ancestry = this.taxonAncestry( taxon );
    const query = squel.select( )
      .field( "t.id" )
      .from( "taxa t" )
      .where( "t.is_active = ?", true )
      .where( "t.id = ? OR t.ancestry = ? OR t.ancestry LIKE ?", taxon.id, ancestry, `${ancestry}/%` );
    const { rows } = await Pool.query( query.toString( ) );
    return _.map( rows, "id" );
  }

  //
  // return IDs of all observations of this taxon and its descendants
  // matching the minimum criteria for photos to be evaluated
  //
  async validObservationsOfTaxon( taxon, options = { } ) {
    let query = squel.select( )
      .field( "o.id" )
      .field( "CASE WHEN o.private_longitude IS NULL THEN o.longitude ELSE o.private_longitude END AS longitude" )
      .field( "CASE WHEN o.private_latitude IS NULL THEN o.latitude ELSE o.private_latitude END AS latitude" )
      .field( "o.positional_accuracy" )
      .field( "o.observed_on" )
      .from( "observations o" )
      .where( "o.observation_photos_count > 0 " );
    if ( taxon.observations_count >= 100000 ) {
      if ( !options.community ) { return []; }
      const ancestry = this.taxonAncestry( taxon );
      query = query.join( "taxa t", null, "o.community_taxon_id = t.id" )
        .where( "t.is_active = ?", true )
        .where( "t.id = ? OR t.ancestry = ? OR t.ancestry LIKE ?", taxon.id, ancestry, `${ancestry}/%` )
        .limit( 200000 );
    }

    const taxonIDs = await this.lookupTaxonIDs( taxon );
    if ( options.community ) {
      query = query.where( "community_taxon_id IN ?", taxonIDs );
    } else {
      query = query
        .where( "taxon_id IN ?", taxonIDs )
        .where( "community_taxon_id IS NULL OR community_taxon_id NOT IN ?", taxonIDs );
    }
    const { rows } = await Pool.query( query.toString( ) );
    const observations = _.keyBy( rows, "id" );
    await ExportVisionNew.assignObservationMetrics( observations );
    await ExportVisionNew.flaggedItems( "Observation", observations );
    return _.omitBy( observations, o => o.flagged );
  }

  async lookupAndProcessTaxonData( taxon, options = { } ) {
    const observations = await this.validObservationsOfTaxon( taxon, options );
    const observationIDs = _.keys( observations );
    const randomIDs = _.shuffle( observationIDs );
    const randomChunks = _.chunk( randomIDs, 500 );
    const promiseProducer = ( ) => {
      if ( this.taxonHasMaximumData( taxon ) ) {
        return null;
      }
      const chunkIDs = randomChunks.shift( );
      const chunkObservations = _.pick( observations, chunkIDs );
      // there are no more observations, so end the promise pool
      if ( _.isEmpty( chunkObservations ) ) { return null; }
      return this.processTaxonDataBatch( taxon, chunkObservations, options );
    };
    await this.asyncPromisePool( promiseProducer, OBSERVATIONS_CONCURRENCY );
  }

  async processTaxonDataBatch( taxon, observations, options = { } ) {
    await this.distributeTaxonGeospatial( taxon, observations, options );
    await this.distributeTaxonPhotosByObservations( taxon, observations, options );
  }

  async distributeTaxonGeospatial( taxon, observations, options = { } ) {
    if ( this.taxonHasMaximumSpatial( taxon ) ) { return; }
    _.each( _.shuffle( observations ), observation => {
      // observations must have coordinates
      if ( !observation.latitude || !observation.longitude || (
        observation.latitude === 0 && observation.longitude === 0 ) ) { return; }
      if ( observation.positional_accuracy > 1000 ) { return; }
      if ( this.taxonPhotosWorking[taxon.id].spatialUsed[observation.id] ) { return; }
      if ( _.size( this.taxonPhotosWorking[taxon.id].obsWithCoords ) < this.spatialMax ) {
        this.addObsToTaxonSpatialSet( observation, taxon, options );
      }
    } );
  }

  //
  // assess observations of this taxon and its descendants, ultimately fully
  // populating and writing data for this taxon, or marking it as incomplete
  //
  async lookupObs( taxon ) {
    this.taxonPhotosWorking = this.taxonPhotosWorking || { };
    this.taxonPhotosWorking[taxon.id] = {
      train: [],
      trainObs: {},
      val: [],
      valObs: {},
      test: [],
      testObs: {},
      allObsPhotos: [],
      photosUsed: {},
      spatialUsed: {},
      obsWithCoords: []
    };
    await this.lookupAndProcessTaxonData( taxon, { community: true } );
    if ( !this.taxonHasMaximumData( taxon ) ) {
      this.distributeMultiplePhotos( taxon, { community: true } );
    }
    if ( !this.taxonHasMaximumData( taxon ) ) {
      this.taxonPhotosWorking[taxon.id].allObsPhotos = [];
      await this.lookupAndProcessTaxonData( taxon, { community: false } );
    }
    if ( !this.taxonHasMaximumData( taxon ) ) {
      this.distributeMultiplePhotos( taxon, { community: false } );
    }

    if ( this.taxonHasMinimumPhotos( taxon ) ) {
      this.taxonLeafClasses[taxon.id] = this.leafClassIndex;
      this.leafClassIndex += 1;
      if ( !_.has( this.taxonIconicClasses, taxon.iconic_taxon_id ) ) {
        this.taxonIconicClasses[taxon.iconic_taxon_id] = this.iconicClassIndex;
        this.iconicClassIndex += 1;
      }
      const taxonPhotos = this.taxonPhotosWorking[taxon.id];
      await this.writePhotosToFile( taxon, taxonPhotos.train, this.trainFileStream );
      await this.writePhotosToFile( taxon, taxonPhotos.test, this.testFileStream );
      await this.writePhotosToFile( taxon, taxonPhotos.val, this.valFileStream );
      await this.writeSpatialToFile( taxon, taxonPhotos.obsWithCoords );
      this.taxonData[taxon.id].status = "populated";
    } else {
      this.taxonData[taxon.id].status = "incomplete";
    }
    this.taxonData[taxon.id].trainCount = _.size( this.taxonPhotosWorking[taxon.id].train );
    this.taxonData[taxon.id].testCount = _.size( this.taxonPhotosWorking[taxon.id].test );
    this.taxonData[taxon.id].valCount = _.size( this.taxonPhotosWorking[taxon.id].val );
    delete this.taxonPhotosWorking[taxon.id];

    this.counter += 1;
    this.outputProgress( );
  }

  async writePhotosToFile( taxon, observationPhotos, file ) {
    await this.forEachInSequence( observationPhotos, async observationPhoto => {
      const { photo } = observationPhoto;
      const photoFileFields = [
        photo.id,
        photo.medium_url.replace( /\?.*$/, "" ),
        this.taxonLeafClasses[taxon.id],
        this.taxonIconicClasses[taxon.iconic_taxon_id],
        taxon.id,
        observationPhoto.community ? 1 : 0
      ];
      await this.writeToFile( file, photoFileFields.join( "," ) );
    } );
  }

  async writeSpatialToFile( taxon, observations ) {
    await this.forEachInSequence( observations, async observation => {
      const spatialFileFields = [
        observation.id,
        _.round( observation.latitude, 4 ),
        _.round( observation.longitude, 4 ),
        observation.observed_on ? observation.observed_on.toISOString( ).slice( 0, 10 ) : "",
        this.taxonLeafClasses[taxon.id],
        this.taxonIconicClasses[taxon.iconic_taxon_id],
        taxon.id,
        observation.community ? 1 : 0,
        observation.isCaptive ? 1 : 0
      ];
      await this.writeToFile( this.spatialFileStream, spatialFileFields.join( "," ) );
    } );
  }

  addObsPhotoToTaxonSet( obsPhoto, taxon, set, options = { } ) {
    const taxonPhotos = this.taxonPhotosWorking[taxon.id];
    taxonPhotos[set].push( obsPhoto );
    taxonPhotos[`${set}Obs`][obsPhoto.observation_id] = taxonPhotos[`${set}Obs`][obsPhoto.observation_id] || 0;
    taxonPhotos[`${set}Obs`][obsPhoto.observation_id] += 1;
    obsPhoto.community = !!options.community;
    taxonPhotos.photosUsed[obsPhoto.photo_id] = true;
  }

  addObsToTaxonSpatialSet( observation, taxon, options = { } ) {
    observation.community = !!options.community;
    this.taxonPhotosWorking[taxon.id].obsWithCoords.push( observation );
    this.taxonPhotosWorking[taxon.id].spatialUsed[observation.id] = true;
  }

  obsOccursInTaxonSet( obsPhoto, taxon, set ) {
    const taxonPhotos = this.taxonPhotosWorking[taxon.id];
    return taxonPhotos[`${set}Obs`][obsPhoto.observation_id] || 0;
  }

  distributeMultiplePhotos( taxon, options = { } ) {
    if ( this.trainPhotosPerObservation < 2 ) { return; }
    const taxonPhotos = this.taxonPhotosWorking[taxon.id];
    _.each( _.shuffle( taxonPhotos.allObsPhotos ), obsPhoto => {
      if ( taxonPhotos.photosUsed[obsPhoto.photo_id] ) { return; }
      if ( _.size( taxonPhotos.train ) >= this.trainMax ) {
        return;
      }
      const obsInTestCount = this.obsOccursInTaxonSet( obsPhoto, taxon, "test" );
      const obsInValCount = this.obsOccursInTaxonSet( obsPhoto, taxon, "val" );
      const obsInTrainCount = this.obsOccursInTaxonSet( obsPhoto, taxon, "train" );
      const obsInTest = obsInTestCount > 0;
      const obsInVal = obsInValCount > 0;
      const trainObsPhotosFull = obsInTrainCount >= this.trainPhotosPerObservation;
      if ( obsInTest || obsInVal || trainObsPhotosFull ) {
        return;
      }
      this.addObsPhotoToTaxonSet( obsPhoto, taxon, "train", options );
    } );
  }

  async distributeTaxonPhotosByObservations( taxon, observations, options = { } ) {
    if ( this.taxonHasMaximumPhotos( taxon ) ) { return; }
    const observationPhotos = await this.photosForObservations( taxon, observations );
    this.distributeTaxonPhotos( taxon, observationPhotos, options );
  }

  async distributeTaxonPhotos( taxon, observationPhotos, options = { } ) {
    if ( this.taxonHasMaximumPhotos( taxon ) ) { return; }
    const taxonPhotos = this.taxonPhotosWorking[taxon.id];
    taxonPhotos.allObsPhotos = taxonPhotos.allObsPhotos.concat( observationPhotos );
    if ( options.community ) {
      // sort them so obs with fewer photos are first to leave more obs w/ multiple photos for train
      // also sort by position so first photos ob observations get used first
      observationPhotos = _.sortBy( observationPhotos,
        op => [op.observationPhotoCount, op.position, _.random( 0.1, 1 )] );
    } else {
      observationPhotos = _.shuffle( observationPhotos );
    }
    _.each( observationPhotos, obsPhoto => {
      if ( taxonPhotos.photosUsed[obsPhoto.photo_id] ) { return; }
      if ( !options.community ) {
        const obsInTrainCount = this.obsOccursInTaxonSet( obsPhoto, taxon, "train" );
        const obsInTrain = obsInTrainCount > 0;
        if ( obsInTrain ) { return; }
        if ( _.size( taxonPhotos.train ) < this.trainMax ) {
          this.addObsPhotoToTaxonSet( obsPhoto, taxon, "train" );
        }
        return;
      }
      const obsInTestCount = this.obsOccursInTaxonSet( obsPhoto, taxon, "test" );
      const obsInValCount = this.obsOccursInTaxonSet( obsPhoto, taxon, "val" );
      const obsInTrainCount = this.obsOccursInTaxonSet( obsPhoto, taxon, "train" );
      const obsInTest = obsInTestCount > 0;
      const obsInVal = obsInValCount > 0;
      const obsInTrain = obsInTrainCount > 0;

      // if a photo from an observation is in test or val, don't use any more
      // photos from the same observation in any set
      if ( obsInTest || obsInVal || obsInTrain ) {
        // do nothing
      } else if ( _.size( taxonPhotos.test ) < this.testMin ) {
        this.addObsPhotoToTaxonSet( obsPhoto, taxon, "test" );
      } else if ( _.size( taxonPhotos.val ) < this.valMin ) {
        this.addObsPhotoToTaxonSet( obsPhoto, taxon, "val" );
      } else if ( _.size( taxonPhotos.train ) < this.trainMax ) {
        this.addObsPhotoToTaxonSet( obsPhoto, taxon, "train", options );
      } else if ( _.size( taxonPhotos.test ) < this.testMax ) {
        this.addObsPhotoToTaxonSet( obsPhoto, taxon, "test" );
      } else if ( _.size( taxonPhotos.val ) < this.valMax ) {
        this.addObsPhotoToTaxonSet( obsPhoto, taxon, "val" );
      }
    } );
  }

  //
  // return IDs from the supplied array which fail any non-wild quality metric
  //
  static async assignObservationMetrics( observations ) {
    const observationIDs = _.keys( observations );
    if ( _.isEmpty( observationIDs ) ) { return; }
    const scores = { };
    const query = squel.select( )
      .field( "observation_id" )
      .field( "metric" )
      .field( "agree" )
      .from( "quality_metrics" )
      .where( "observation_id IN ?", observationIDs );
    const { rows } = await Pool.query( query.toString( ) );
    _.each( rows, row => {
      scores[row.observation_id] = scores[row.observation_id] || { };
      scores[row.observation_id][row.metric] = scores[row.observation_id][row.metric] || 0;
      scores[row.observation_id][row.metric] += row.agree ? 1 : -1;
    } );
    _.each( scores, ( metrics, observationID ) => {
      _.each( metrics, ( score, metric ) => {
        if ( score < 0 ) {
          if ( metric === "wild" ) {
            observations[observationID].isCaptive = true;
          } else {
            observations[observationID].failsNonWildMetric = true;
          }
        }
      } );
    } );
  }

  //
  // return IDs from the supplied array and type which have any unresolved flags
  //
  static async flaggedItems( type, objects ) {
    const ids = _.keys( objects );
    if ( _.isEmpty( ids ) ) { return; }
    const query = squel.select( )
      .field( "flaggable_id" )
      .from( "flags" )
      .where( "flaggable_type = ?", type )
      .where( "resolved = ?", false )
      .where( "flaggable_id IN ?", ids );
    const { rows } = await Pool.query( query.toString( ) );
    _.each( rows, row => {
      objects[row.flaggable_id].flagged = true;
    } );
  }

  //
  // return photo IDs from all observations in the supplied array that are
  // eligible for inclusion in the export
  //
  async observationPhotos( taxon, observations ) {
    // never use photos from observations with failed quality metrics other than wild,
    // e.g. photos of captive organisms is OK but photos not showing evidence are not OK
    const observationIDs = _.keys( _.omitBy( observations, o => o.failsNonWildMetric ) );
    if ( _.isEmpty( observationIDs ) ) { return []; }
    const query = squel.select( )
      .field( "photo_id" )
      .field( "observation_id" )
      .field( "COALESCE( position, photo_id ) as position" )
      .from( "observation_photos" )
      .where( "observation_id IN ?", observationIDs );
    const { rows } = await Pool.query( query.toString( ) );
    const observationPhotosCounts = _.countBy( rows, "observation_id" );
    let obsPhotoPosition = 0;
    let lastObsID = 0;
    const sortedRows = _.sortBy( rows, ["observation_id", "position"] );
    // ensure photo positions are in sequence starting at 0
    _.each( sortedRows, row => {
      if ( row.observation_id !== lastObsID ) {
        lastObsID = row.observation_id;
        obsPhotoPosition = 0;
      } else {
        obsPhotoPosition += 1;
      }
      row.observationPhotoCount = observationPhotosCounts[row.observation_id];
      row.position = obsPhotoPosition;
    } );
    const observationPhotos = _.keyBy( sortedRows, "photo_id" );
    await ExportVisionNew.flaggedItems( "Photo", observationPhotos );
    return _.omitBy( observationPhotos, "flagged" );
  }

  //
  // process photos of observations with the supplied IDs
  //
  async photosForObservations( taxon, observations ) {
    const observationPhotos = await this.observationPhotos( taxon, observations );
    if ( _.isEmpty( observationPhotos ) ) { return []; }
    const query = squel.select( )
      .field( "id" )
      .field( "medium_url" )
      .from( "photos" )
      .where( "id IN ?", _.keys( observationPhotos ) );
    const { rows } = await Pool.query( query.toString( ) );
    _.each( rows, row => {
      observationPhotos[row.id].photo = row;
    } );
    return _.filter( _.values( observationPhotos ), op => (
      !_.isEmpty( op.photo ) && !_.isEmpty( op.photo.medium_url )
    ) );
  }

  //
  // return the highest taxon ID in the table
  //
  static async maxTaxonID( ) {
    const query = squel.select( )
      .field( "max(id) as max" )
      .from( "taxa" );
    const { rows } = await Pool.query( query.toString( ) );
    return rows[0].max;
  }

  static taxonNeedsProcessing( taxon ) {
    // taxa that are fully "populated" or complete because
    // decendants are populated don't need to be processed
    if ( taxon.status === "complete"
      || taxon.status === "populated"
      || taxon.status === "skipped" ) {
      return false;
    }
    return true;
  }

  //
  // returns true if taxon is already in a filter branch
  //
  assessWithinFilterBranch( taxon, withinFilterBranch ) {
    if ( withinFilterBranch ) { return true; }
    if ( _.isEmpty( this.selectTaxonIDs ) ) { return false; }
    // this is a filter taxon, so set selectedBranch
    if ( _.includes( this.selectTaxonIDs, taxon.id ) ) { return true; }
    if ( !_.includes( this.selectTaxonAncestors, taxon.id ) ) {
      // this isn't a filter taxon or a descendant of one, so skip this branch
      taxon.status = "skipped";
      return false;
    }
    return false;
  }

  //
  // set the taxon's status if it is known to be globally extinct
  //
  assessTaxonExtinct( taxon ) {
    if ( this.extinctTaxonIDs[taxon.id] ) {
      taxon.status = "skipped";
    }
  }

  //
  // create the directory which will store all files for the export
  //
  async createOutputDir( ) {
    try {
      /* eslint-disable-next-line no-bitwise */
      await fsPromises.access( this.runOptions.dir, fs.constants.R_OK | fs.constants.W_OK );
    } catch ( err ) {
      throw new Error(
        `output dir [${this.runOptions.dir}] does not exist or you do not have read/write permission`
      );
    }
    // const todaysDate = moment( ).format( "YYYYMMDDHHmmss" );
    // this.outputDirName = `vision-export-${todaysDate}`;
    this.outputDirName = "exporttest";
    this.outputDir = path.join( this.runOptions.dir, this.outputDirName );
    if ( !fs.existsSync( this.outputDir ) ) {
      fs.mkdirSync( this.outputDir );
    }
  }

  //
  // create streams for all the files in the export and populate the header rows
  //
  async createCSVFiles( ) {
    this.taxonomyFileStream = fs.createWriteStream(
      path.join( this.outputDir, "taxonomy.csv" ), { flags: "w" }
    );
    await this.writeToFile( this.taxonomyFileStream,
      "parent_taxon_id,taxon_id,rank_level,leaf_class_id,iconic_class_id,name" );

    this.taxonomyVisualFileStream = fs.createWriteStream(
      path.join( this.outputDir, "taxonomy_visual.txt" ), { flags: "w" }
    );
    await this.writeToFile( this.taxonomyVisualFileStream,
      "Name, ID, Rank, Status, (Train::Val::Test)\n" );

    this.iconicFileStream = fs.createWriteStream(
      path.join( this.outputDir, "iconic_taxa.csv" ), { flags: "w" }
    );
    await this.writeToFile( this.iconicFileStream,
      "iconic_taxon_id,iconic_class_id,name" );

    this.spatialFileStream = fs.createWriteStream(
      path.join( this.outputDir, "spatial_data.csv" ), { flags: "w" }
    );
    await this.writeToFile( this.spatialFileStream,
      "observation_id,latitude,longitude,observed_on,leaf_class_id,iconic_class_id,taxon_id,community,captive" );

    await this.forEachInSequence( ["train", "val", "test"], async set => {
      const streamName = `${set}FileStream`;
      this[streamName] = fs.createWriteStream(
        path.join( this.outputDir, `${set}_data.csv` ), { flags: "w" }
      );
      await this.writeToFile( this[streamName], "photo_id,photo_url,leaf_class_id,iconic_class_id,taxon_id,community" );
    } );
  }

  //
  // return a string representing a /-delimited list of the given taxon's ancestor IDs
  //
  taxonAncestry( taxon ) {
    if ( taxon && taxon.parentID ) {
      const parentAncestry = this.taxonAncestry( this.taxonData[taxon.parentID] );
      return `${parentAncestry}/${taxon.id}`;
    }
    return `${taxon.id}`;
  }

  async parallelProcess( method, startID, maxID, batchSize, concurrency = 1 ) {
    let iterationStartID;
    const promiseProducer = ( ) => {
      iterationStartID = _.isUndefined( iterationStartID )
        ? startID
        : iterationStartID + batchSize;
      if ( iterationStartID >= maxID ) {
        return null;
      }
      return method.bind( this )( iterationStartID, iterationStartID + batchSize );
    };
    await this.asyncPromisePool( promiseProducer, concurrency );
  }

  async asyncPromisePool( promiseProducer, concurrency ) {
    const pool = new PromisePool( promiseProducer, concurrency );
    try {
      await pool.start( );
    } catch ( err ) {
      console.log( err );
      console.trace( );
    }
  }

  // //
  // // lookup all file prefixes and populat an instance variable with the results
  // //
  // async lookupFilePrefixes( ) {
  //   const query = squel.select( )
  //     .field( "id" )
  //     .field( "prefix" )
  //     .from( "file_prefixes" );
  //   const { rows } = await Pool.query( query.toString( ) );
  //   this.filePrefixes = _.fromPairs( _.map( rows, r => ( [r.id, r.prefix] ) ) );
  // }

  // //
  // // lookup all file extensions and populat an instance variable with the results
  // //
  // async lookupFileExtensions( ) {
  //   const query = squel.select( )
  //     .field( "id" )
  //     .field( "extension" )
  //     .from( "file_extensions" );
  //   const { rows } = await Pool.query( query.toString( ) );
  //   this.fileExtensions = _.fromPairs( _.map( rows, r => ( [r.id, r.extension] ) ) );
  // }

  //
  // lookup IDs of all globally extinct taxa and populate an instance variable with the results
  //
  async lookupGloballyExtinctTaxonIDs( ) {
    const query = squel.select( )
      .field( "DISTINCT( taxon_id )" )
      .from( "conservation_statuses" )
      .where( "iucn = 70" )
      .where( "place_id IS NULL" );
    const { rows } = await Pool.query( query.toString( ) );
    this.extinctTaxonIDs = _.keyBy( _.map( rows, "taxon_id" ) );
  }

  //
  // basic logging of progress for a depth-first pass of taxon lookups
  //
  outputProgress( ) {
    const timeElapsed = ( Date.now( ) - this.startTime ) / 1000;
    const perSecond = this.counter / timeElapsed;
    const secondsLeft = ( this.total - this.counter ) / perSecond;
    if ( this.counter % 10 === 0 ) {
      console.log( `Processed ${this.counter} taxa in ${_.round( timeElapsed, 2 )}s; `
        + `${_.round( perSecond, 2 )}/s; ${_.round( secondsLeft, 2 )}s left; ` );
    }
  }

  //
  // write to the console a hierarchical representation of all taxa assessed for the export
  //
  async printTree( taxon = null, ancestorLinePrefix = "", linePrefix = "" ) {
    if ( taxon ) {
      const taxaFileFields = [
        taxon.parentID === Taxon.life.id ? "" : taxon.parentID,
        taxon.id,
        taxon.rank_level,
        _.has( this.taxonLeafClasses, taxon.id ) ? this.taxonLeafClasses[taxon.id] : "",
        _.has( this.taxonLeafClasses, taxon.id ) ? this.taxonIconicClasses[taxon.iconic_taxon_id] : "",
        taxon.name ? taxon.name.replace( /,/g, "" ) : ""
      ];
      if ( taxon.parentID !== 0 && taxon.status !== "incomplete" ) {
        await this.writeToFile( this.taxonomyFileStream, taxaFileFields.join( "," ) );
      }

      let consoleOutput = `\x1b[33m${linePrefix}\x1b[0m\x1b[32m${taxon.name}\x1b[0m \x1b[34mID: ${taxon.id}\x1b[0m ${taxon.status}`;
      let fileOutput = `${linePrefix}${taxon.name}, ${taxon.id}, ${taxon.rank}, ${taxon.status}`;
      if ( taxon.status !== "complete" ) {
        const counts = `, ${taxon.trainCount}::${taxon.testCount}::${taxon.valCount}`;
        consoleOutput += counts;
        fileOutput += counts;
      }
      // console.log( consoleOutput );
      await this.writeToFile( this.taxonomyVisualFileStream, fileOutput );
    }

    const childIDs = taxon ? this.taxonChildren[taxon.id] : this.taxonChildren[0];
    if ( !_.isEmpty( childIDs ) && !( taxon && _.includes( this.customLeafTaxonIDs, taxon.id ) ) ) {
      const children = _.map( _.keys( childIDs ), childID => this.taxonData[childID] );
      const unskippedChildren = _.filter( children, child => (
        child.status !== "skipped"
      ) );
      const lastChild = _.last( unskippedChildren );

      await this.forEachInSequence( unskippedChildren, async child => {
        const lastInBranch = child.id === lastChild.id;
        let icon = lastInBranch ? "└──" : "├──";
        let prefixIcon = lastInBranch ? "   " : "│   ";
        if ( _.isEmpty( taxon ) ) {
          icon = "";
          prefixIcon = "";
        }
        await this.printTree( child, `${ancestorLinePrefix}${prefixIcon}`, `${ancestorLinePrefix}${icon}` );
      } );
    }
  }

  async printStats( ) {
    const trainTotal = _.sum( _.map( _.keys( this.taxonLeafClasses ),
      taxonID => this.taxonData[taxonID].trainCount ) );
    const testTotal = _.sum( _.map( _.keys( this.taxonLeafClasses ),
      taxonID => this.taxonData[taxonID].testCount ) );
    const valTotal = _.sum( _.map( _.keys( this.taxonLeafClasses ),
      taxonID => this.taxonData[taxonID].valCount ) );
    const stats = [
      `Total leaves: ${this.leafClassIndex}`,
      `Total train photos: ${trainTotal}`,
      `Total test photos: ${testTotal}`,
      `Total val photos: ${valTotal}`
    ];
    await this.forEachInSequence( stats, async stat => {
      console.log( stat );
      await this.writeToFile( this.taxonomyVisualFileStream, stat );
    } );
  }

  async writeToFile( fileStream, line ) {
    if ( !fileStream.write( `${line}\n` ) ) {
      await once( fileStream, "drain" );
    }
  }

  async forEachInSequence( items, asyncFunction ) {
    await items.reduce( async ( promise, item ) => {
      await promise;
      await asyncFunction( item );
    }, Promise.resolve( ) );
  }
};

module.exports = VisionDataExporter;
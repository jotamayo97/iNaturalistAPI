const _ = require( "lodash" );
const { initialize } = require( "express-openapi" );
const swaggerUi = require( "swagger-ui-express" );
const bodyParser = require( "body-parser" );
const fs = require( "fs" );
const path = require( "path" );
const multer = require( "multer" );
const crypto = require( "crypto" );
const jwt = require( "jsonwebtoken" );
const openapiCoercer = require( "openapi-request-coercer" );
const config = require( "./config" );
const v1ApiDoc = require( "./openapi/doc" );
const util = require( "./lib/util" );
const Logstasher = require( "./lib/logstasher" );

const logstashPath = path.join(
  path.dirname( fs.realpathSync( __filename ) ), "./log", "inaturalist_api.4000.log"
);
Logstasher.setLogStreamFilePath( logstashPath );

const InaturalistAPI = require( "./lib/inaturalist_api" ); // eslint-disable-line global-require

const app = InaturalistAPI.server( );

let initializedApi = null;

app.use( bodyParser.json( {
  type: req => {
    // Parser the request body for everything other than multipart requests,
    // which should specify body data as plain old form data which express can
    // parse on its own.
    if ( !req.headers["content-type"] ) {
      return true;
    }
    return req.headers["content-type"].match( /multipart/ ) === null;
  }
} ) );


app.use( ( req, res, next ) => {
  util.timingMiddleware( req, res, next );
} );

app.use( ( req, res, next ) => {
  const methodOverride = req.header( "X-HTTP-Method-Override" );
  if ( req.method === "POST" && methodOverride === "GET" && initializedApi ) {
    const basePath = initializedApi.basePaths[0].path;
    const basePathRegex = new RegExp( `^${_.escapeRegExp( basePath )}` );
    const apiPath = req.path.replace( basePathRegex, "" );
    const apiMethod = initializedApi.apiDoc.paths[apiPath];
    if ( apiMethod && apiMethod.post ) {
      const allowsOverride = _.find( apiMethod.post.parameters, p => (
        p.name === "X-HTTP-Method-Override" && p.in === "header"
      ) );
      if ( allowsOverride ) {
        req.originalMethod = req.originalMethod || req.method;
        req.method = "GET";
      }
    }
  }
  next( );
} );

const storage = multer.diskStorage( {
  destination: ( req, file, callback ) => {
    crypto.pseudoRandomBytes( 16, ( err, raw ) => {
      const time = Date.now( );
      const hash = raw.toString( "hex" );
      // create a directory in which to store the upload
      const uploadDir = `openapi/uploads/tmp_${time}_${hash}`;
      if ( !fs.existsSync( uploadDir ) ) {
        fs.mkdirSync( uploadDir );
      }
      callback( null, uploadDir );
    } );
  },
  filename: ( req, file, callback ) => callback( null, file.originalname )
} );

const upload = multer( { storage } );

const validateAllResponses = ( req, res, next ) => {
  const strictValidation = !!req.apiDoc["x-express-openapi-validation-strict"];
  if ( typeof res.validateResponse === "function" ) {
    const { send } = res;
    res.send = function expressOpenAPISend( ...args ) {
      const onlyWarn = !strictValidation;
      if ( res.get( "x-express-openapi-validated" ) !== undefined ) {
        return send.apply( res, args );
      }
      const body = args[0];
      let validation = res.validateResponse( res.statusCode, body );
      let validationMessage;
      if ( validation === undefined ) {
        validation = { message: undefined, errors: undefined };
      }
      if ( validation.errors ) {
        const errorList = Array.from( validation.errors ).map( e => e.message ).join( "," );
        validationMessage = `Invalid response for status code ${res.statusCode}: ${errorList}`;
        console.warn( validationMessage );
        // Set to avoid a loop, and to provide the original status code
        res.set( "x-express-openapi-validation-error-for", res.statusCode.toString( ) );
      }
      res.set( "x-express-openapi-validated", true );
      if ( onlyWarn || !validation.errors ) {
        return send.apply( res, args );
      }
      res.status( 500 );
      return res.json( { error: validationMessage } );
    };
  }
  next( );
};

const jwtValidate = req => new Promise( resolve => {
  if ( !req.headers.authorization ) {
    return void resolve( );
  }
  const token = _.last( req.headers.authorization.split( /\s+/ ) );
  jwt.verify( token, config.jwtSecret || "secret", { algorithms: ["HS512"] }, ( err, payload ) => {
    if ( err ) {
      return void resolve( );
    }
    req.userSession = payload;
    resolve( true );
  } );
} );

initializedApi = initialize( {
  app,
  docPath: "api-docs",
  apiDoc: {
    ...v1ApiDoc,
    "x-express-openapi-additional-middleware": [validateAllResponses]
    // "x-express-openapi-validation-strict": true
  },
  enableObjectCoercion: true,
  dependencies: {
    sendWrapper: ( res, err, results ) => {
      if ( err ) { return void initializedApi.args.errorMiddleware( err, null, res, null ); }
      res.status( 200 ).send( results );
    }
  },
  securityFilter: ( req, res ) => {
    // remove x-express-* attributes which don't need to be in the official documentation
    res.status( 200 ).json( _.pickBy( req.apiDoc, ( value, key ) => !key.match( /^x-/ ) ) );
  },
  paths: "./openapi/paths/v2",
  promiseMode: true,
  securityHandlers: {
    jwtOptional: req => jwtValidate( req ).then( ( ) => true ),
    jwtRequired: req => jwtValidate( req )
  },
  consumesMiddleware: {
    // TODO: custom coercion for JSON bodies?
    "multipart/form-data": ( req, res, next ) => {
      const knownUploadFields = [];
      const { properties } = req.operationDoc.requestBody.content["multipart/form-data"].schema;
      _.each( properties, ( schema, name ) => {
        if ( schema.type === "string" && schema.format === "binary" ) {
          knownUploadFields.push( name );
        }
      } );
      const props = req.operationDoc.requestBody.content["multipart/form-data"].schema.properties;
      const parameters = _.map( _.keys( props ), k => ( {
        in: "formData",
        name: k,
        schema: req.operationDoc.requestBody.content["multipart/form-data"].schema.properties[k]
      } ) );
      const coercer = new openapiCoercer.default( {
        extensionBase: "x-express-openapi-coercion",
        loggingKey: "express-openapi-coercion",
        parameters,
        enableObjectCoercion: true
      } );
      coercer.coerce( req );

      upload.fields( _.map( knownUploadFields, f => ( { name: f } ) ) )( req, res, err => {
        const originalBody = _.cloneDeep( req.body );
        const newBody = { };
        _.each( originalBody, ( v, k ) => {
          if ( _.isObject( v ) ) {
            newBody[k] = { };
            _.each( v, ( vv, kk ) => {
              if ( vv !== "" ) {
                newBody[k][kk] = vv;
              }
            } );
          } else {
            newBody[k] = v;
          }
        } );
        req.body = newBody;
        coercer.coerce( req );
        next( );
      } );
    }
  },
  // this needs all 4 parameters even if next is not used
  /* eslint-disable-next-line no-unused-vars */
  errorMiddleware: ( err, req, res, next ) => {
    if ( err.errorCode === "authentication.openapi.security" ) {
      res.status( err.status || 401 ).json( {
        status: err.status || 401,
        message: "Unauthorized"
      } );
      return;
    }
    console.trace( err );
    res.status( err.status || 500 ).json( err instanceof Error
      ? { status: 500, message: err.message, stack: err.stack.split( "\n" ) }
      : err );
  }
} );


app.get( "/v2/", ( req, res ) => res.redirect( "/v2/docs" ) );

app.use( "/v2/docs", swaggerUi.serve, swaggerUi.setup( initializedApi.apiDoc ) );

app.listen( 4000 );

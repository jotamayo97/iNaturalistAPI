var ElasticMapper = require( "elasticmaps" ),
    InaturalistMapserver = require( "./lib/inaturalist_map_server" ),
    routes = require( "./lib/routes" ),
    _ = require( "underscore" ),
    jade = require( "jade" ),
    express = require( "express" ),
    bodyParser = require( "body-parser" ),
    config = require( "./config" );

var app = ElasticMapper.server( _.extend( config, {
  beforePrepareQuery: InaturalistMapserver.beforePrepareQuery,
  prepareQuery: InaturalistMapserver.prepareQuery,
  prepareStyle: InaturalistMapserver.prepareStyle,
  beforeSendResult: InaturalistMapserver.beforeSendResult
}));

app.use( bodyParser.json( ) );
app.use( express.static( "public" ) );
app.set( "view engine", "jade" );

app.use( function( req, res, next ) {
  res.header( "Access-Control-Allow-Origin", "*" );
  res.header( "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept" );
  next( );
});

app.get( "/", routes.index );
app.get( "/observations", routes.observations_index );
app.get( "/observations/:id", routes.observations_show );
app.get( "/map", function ( req, res ) {
  res.render( "map" );
});
app.get( "/facets", function ( req, res ) {
  res.render( "facets" );
});

var port = Number( process.env.PORT || 4000 );
server = app.listen( port, function( ) {
  console.log( "Listening on " + port );
});

require( "./lib/socket" ).connect( server );

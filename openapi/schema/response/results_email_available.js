const Joi = require( "joi" );

module.exports = Joi.object( ).keys( {
  available: Joi.boolean( )
} );

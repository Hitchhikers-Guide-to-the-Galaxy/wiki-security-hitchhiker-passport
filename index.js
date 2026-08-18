// **index.js**
// Simple file so that if you require this directory
// in node it instead requires ./lib/social.coffee

require("coffeescript");
require("coffeescript/register");

module.exports = require("./server/social");

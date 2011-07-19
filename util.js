var fs = require('fs')
  , Log = require('log')
  , log = new Log(Log.DEBUG, fs.createWriteStream('gtalkjsonproxy.log'));

var base64 = require('base64');

module.exports.crypto = {
	key: undefined,
	crypto: require("crypto"),
	
	init: function(key) {
		this.key = key;
		
		if(typeof(this.key) != 'string') {
			this.key = this.key.toString();
		}
	},
	
	cipher: function(data, key, saltSize) {
		if (saltSize === undefined) saltSize = 32 * 6;
		
		var salt = module.exports.randomString(saltSize),
		    cipher = this.crypto.createCipher('aes-256-cbc', salt + '$' + ((typeof key === 'string') ? key : this.key)),
		    buf = new Buffer(data, 'utf8');
		
		return buf.length + ":" + salt + ":" + base64.encode(new Buffer(cipher.update(buf, 'binary', 'binary') + cipher.final('binary'), 'binary'));
	},
	
	decipher: function(data, key) {
		var sd = data.split(':'),
		    len = parseInt(sd[0]),
		    target = new Buffer(len),
		    salt = sd[1],
		    decipher = this.crypto.createDecipher('aes-256-cbc', salt + '$' + ((typeof key === 'string') ? key : this.key)),
		    first = new Buffer(decipher.update(base64.decode(sd[2]), 'binary', 'binary'), 'binary'),
		    end = new Buffer(decipher.final('binary'), 'binary');
		
		first.copy(target);
		end.copy(target, first.length, 0, len - first.length);
		
		return target.toString('utf8');
	}
};

module.exports.randomString = function(bits) {
	var rand, i;
	var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-/';
	var ret = '';
	
	// in v8, Math.random() yields 32 pseudo-random bits (in spidermonkey it gives 53)
	while(bits > 0) {
		rand = Math.floor(Math.random()*0x100000000); // 32-bit integer
		 
		// base 64 means 6 bits per character, so we use the top 30 bits from rand to give 30/6=5 characters.
		for(i = 26; i > 0 && bits > 0; i -= 6, bits -= 6) {
			ret += chars[0x3F & rand >>> i];
		}
	}
	
	return ret;
};

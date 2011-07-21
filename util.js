module.exports.crypto = {
	key: undefined,
	crypto: require("crypto"),
	
	init: function(key) {
		this.key = key;
		
		if(typeof(this.key) != 'string') {
			this.key = this.key.toString();
		}
	},
	
	cipher: function(data) {
		var salt = module.exports.randomString(32 * 6);
		
		var cipher = this.crypto.createCipher('aes-256-cbc', salt + '$' + this.key);
		
		return data.length + ":" + salt + ":" + cipher.update(data, 'utf8', 'hex') + cipher.final('hex');
	},
	
	decipher: function(data) {
		var sd = data.split(':');
		
		var len  = parseInt(sd[0]);
		var salt = sd[1];
		
		var decipher = this.crypto.createDecipher('aes-256-cbc', salt + '$' + this.key);
		
		return (decipher.update(sd[2], 'hex', 'utf8') + decipher.final('utf8')).substring(0, len);
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

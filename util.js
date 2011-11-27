var base64 = require('base64'),
    xml2js = require('xml2js'),
	gzip = require('gzip');

module.exports.crypto = {
	key: undefined,
	crypto: require("crypto"),
	
	init: function(key) {
		this.key = key;
		
		if(typeof(this.key) != 'string') {
			this.key = this.key.toString();
		}
	},
	
	cipher: function(data, key, saltSize, compressCb) {
		if (saltSize === undefined) saltSize = 32 * 6;
		
		var salt = module.exports.randomString(saltSize),
		    cipher = this.crypto.createCipher('aes-256-cbc', salt + '$' + ((typeof key === 'string') ? key : this.key));
		
		if(compressCb) {
			gzip(data, function(err, buf) {
				compressCb(buf.length + ":" + salt + ":" + base64.encode(new Buffer(cipher.update(buf, 'binary', 'binary') + cipher.final('binary'), 'binary')));
			});
		} else {
			var buf = new Buffer(data, 'utf8');
			
			return buf.length + ":" + salt + ":" + base64.encode(new Buffer(cipher.update(buf, 'binary', 'binary') + cipher.final('binary'), 'binary'));
		}
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

var XmlStream = module.exports.XmlStream = function() {
	this.good = "";
	this.remaining = "";
	this.ptr = 0;
	this.state = "text";
	this.nesting = 0;
	this.tag = /<(\/?)\s*([^ >/]+)[^>]*?(\/?)>/g;
	this.utf = "";
};

XmlStream.prototype = new process.EventEmitter();

XmlStream.prototype.update = function(buf, offset, len) {
	if(typeof offset == 'undefined') offset = 0;
	if(typeof len == 'undefined') len = buf.length - offset;
	
	if(len <= 0) return;
	
	var nextUtf = "";
	
	if((buf[offset+len-1] & 0x80) != 0) {
		// oh oh, the last character may be an incomplete UTF8 character.
		
		var origLen = len;
		var utfCharStart = offset + (--len);
		
		while(utfCharStart >= offset && (buf[utfCharStart] & 0xC0) == 0x80) {
			utfCharStart--;
			len--;
		}
		
		if(utfCharStart < offset) {
			this.utf += buf.slice(offset, origLen).toString('binary');
			
			return;
		} else {
			nextUtf = buf.slice(utfCharStart, origLen).toString('binary');
		}
	}
	
	if(this.utf.length == 0) {
		this.remaining += buf.slice(offset, offset + len).toString('utf8');
	} else {
		var newBuf = new Buffer(this.utf.length + len);
		
		newBuf.write(this.utf, 0, 'binary');
		buf.copy(newBuf, this.utf.length, offset, offset + len);
		
		this.remaining += newBuf.toString('utf8');
	}
	
	this.utf = nextUtf;

	var m;
	var begin = 0;
	var last = 0;
	var self = this;
	
	while ((m = this.tag.exec(this.remaining)) != null) {	
		last = this.tag.lastIndex;
		
		if(m[2] == 'stream:stream') {
			self.emit('data', {'stream:stream': {}});
			begin = last;
			continue;
		} if(m[1] == '/') {
			this.nesting--;
		} else if(m[3] != '/') {
			this.nesting++;
		}
		
		if(this.nesting == 0) {
			var parser = new xml2js.Parser();
						
			parser.addListener('end', function(result) {
				self.emit('data', result);
			});
			
			parser.parseString('<x>' + this.good + this.remaining.substring(begin, last) + '</x>');
			begin = last;
			this.good = '';
		}
	}
	
	this.good += this.remaining.substring(begin, last);
	this.remaining = this.remaining.substring(last);
};

module.exports.json

module.exports.xmlify = function(tag, json) {
	if(typeof(json) == 'object' && json.length) {
		var xml = "";
		for(var i = 0; i < json.length; i++) {
			xml += module.exports.xmlify(tag, json[i]);
		}
		return xml;
	} else if(tag == '#') {
		return module.exports.xmlEscape(json);
	} else if(!json) {
		return '';
	} else if(typeof(json) == 'string') {
		return "<" + tag + ">" + module.exports.xmlEscape(json) + "</" + tag + ">";
	}
	
	var xml = "<" + tag;
	
	if(json['@']) {
		for(var key in json['@']) {
			if(!json['@'].hasOwnProperty(key)) continue;
			
			xml += " " + key + "='" + module.exports.xmlEscape(json['@'][key]) + "'";
		}
	}
	
	var children = "";
	
	for(var key in json) {
		if(key == '@' || !json.hasOwnProperty(key)) continue;
		
		children += module.exports.xmlify(key, json[key]);
	}
	
	if(children.length == 0) {
		xml += '/>';
	} else {
		xml += '>' + children + '</' + tag + '>';
	}
	
	return xml;
};

module.exports.xmlEscape = function(str) {
	return str.replace(/&/g, '&amp;')
		.replace(/'/g, '&apos;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}
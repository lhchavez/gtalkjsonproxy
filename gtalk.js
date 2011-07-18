function gtalk(username, auth) {
	this.username = username;
	this.server = username.split('@')[1];
	this.auth = auth;
	this.logged_in = false;
	this.jid = undefined;
	this.sock = undefined;
	this.rosterList = {};
};

gtalk.prototype = new process.EventEmitter();

gtalk.prototype.login = function(cb) {
	var base64_encode = require("base64").encode;
	var Buffer = require('buffer').Buffer;
	var xml2js = require('xml2js');

	var s = require("net").createConnection(5222, 'talk.google.com');
	var self = this;
	
	s.on('connect', function() {
		s.write("<?xml version='1.0'?>\n<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
	}).on('data', function(data) {
		var str = data.toString('utf8');
	
		if(str.indexOf('stream:features') != -1) {
			s.write("<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls' />");
		} else if(str.indexOf('proceed') != -1) {
			s.removeAllListeners('data');
		
			require('./starttls')(s, {}, function(ss) {
				if(!ss.authorized) {
					self.emit('auth_failure', ss.authorizationError);
					ss.destroy();
					return;
				}
			
				ss.write("<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
				self.sock = ss;
			
				ss.on('data', function(data) {
					var str = data.toString('utf8');
				
					if(str.indexOf('stream:features') != -1) {
						if(self.logged_in) {
							ss.write("<iq type='set' id='bind_resource'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>wpmango</resource></bind></iq>");
							ss.write("<iq to='" + self.server + "' type='set' id='session'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>");
						} else {
							var token = base64_encode(new Buffer('\u0000' + self.username + '\u0000' + self.auth));
					
							ss.write("<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='X-GOOGLE-TOKEN'>" + token + "</auth>");
						}
					} else if(str.indexOf('success') != -1) {
						self.logged_in = true;
						
						ss.write("<stream:stream to='" + self.server + "' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>");
					} else if(str.indexOf('failure') != -1) {
						self.emit('auth_failure', str);
						self.logout();
					} else if(str.indexOf('iq') != -1) {
						if(str.indexOf('session') != -1) {
							ss.removeAllListeners('data');
							var parser = new xml2js.Parser();
							parser.addListener('end', function(result) {
								if(result.presence) {
									if(result.presence.length) {
										for(i = 0; i < result.presence.length; i++) {
											self.emit('presence', self.stripPresence(result.presence[i]));
										}
									} else {
										self.emit('presence', self.stripPresence(result.presence));
									}
								} else if(result.message) {
									if(result.message.length) {
										for(i = 0; i < result.message.length; i++) {
										self.emit('message', self.stripMessage(result.message[i]));
										}
									} else {
										self.emit('message', self.stripMessage(result.message));
									}
								}
							});
							ss.addListener('data', function(d) {
								parser.parseString("<x>" + d.toString('utf8') + "</x>");
							});
							ss.write("<presence/>");
						} else if(str.indexOf('bind_resource') != -1) {
							self.jid = str.match(/<jid>([^>]*)<\/jid>/)[1];
							
							if(cb) cb();
						}
					}
				});
			});
		}
	});
};

gtalk.prototype.stripMessage = function(m) {
	var msg = {'from': m['@'].from};
	
	if(m['@'].type) msg.type = m['@'].type;
	if(m.body) msg.body = m.body;
	if(m['nos:x']) msg.otr = m['nos:x']['@'].value == 'enabled';
	
	return msg;
};

gtalk.prototype.stripPresence = function(p) {
	var pre = {'from': p['@'].from};
	
	if(p['@'].type) pre.type = p['@'].type;
	if(p.show) pre.show = p.show;
	if(p.status && typeof(p.status) == 'string') pre.status = p.status;
	if(p.x && p.x.photo) pre.photo = p.x.photo;
	
	this.rosterList[pre.from.split("/")[0]] = pre;
	
	return pre;
}

gtalk.prototype.send = function(data, cb) {
	this.sock.write(data, cb);
};

gtalk.prototype.message = function(to, body, cb) {
	this.send("<message from='" + this.jid + "' to='" + to + "'><body>" + body + "</body><nos:x value='disabled' xmlns:nos='google:nosave' /><arc:record otr='false' xmlns:arc='http://jabber.org/protocol/archive' /></message>", cb);
};

gtalk.prototype.roster = function(cb) {
	for(var username in this.rosterList) {
		if(typeof(username) != 'string') continue;
		
		cb(this.rosterList[username]);
	}
	
	cb(null);
}

gtalk.prototype.logout = function() {
	var self = this;
	this.send("</stream:stream>", function() {
		self.sock.destroy();
	});
};

module.exports = function(username, auth) {
	return new gtalk(username, auth);
};

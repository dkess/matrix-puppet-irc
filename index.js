const path = require('path');
const irc = require('irc');
const config = require('./config.json');
const {
  MatrixAppServiceBridge: {
    Bridge, Cli, AppServiceRegistration, Intent
  },
  Puppet,
  MatrixPuppetBridgeBase
} = require("matrix-puppet-bridge");
const puppet = new Puppet('./config.json');
const debug = require('debug')('matrix-puppet:irc');
const Promise = require('bluebird');

class App extends MatrixPuppetBridgeBase {
  getServicePrefix() {
    return this.config.irc.servicePrefix;
  }
  getServiceName() {
    return this.config.irc.serviceName;
  }
  createClient() {
    return new irc.Client(this.config.irc.server, this.config.irc.nick, {
      port: this.config.irc.port,
      password: this.config.irc.password,
      retryCount: 3,
      retryDelay: 30000
    });
  }
  initThirdPartyClient() {
    this.client = this.createClient();
    var client = this.client;
    var app = this;
    var isAway = false;
    var readOnUnaway = this.config.readOnUnaway;

    client.on('names', function (chan, nicks) {
      var matrixRoomIdFuture = app.getOrCreateMatrixRoomFromThirdPartyRoomId(chan);
      matrixRoomIdFuture.then((roomId) => {
	var matrixMembers = new Set(app.puppet.getMatrixRoomMembers(roomId));
	for (var nick in nicks) {
	  if (!nicks.hasOwnProperty(nick)) continue;

	  var userId = app.getGhostUserFromThirdPartySenderId(nick);
	  matrixMembers.delete(userId);
	}
	for (let userId of matrixMembers) {
	  var nick = app.getThirdPartyUserIdFromMatrixGhostId(userId);
	  if (nick) {
	    app.getIntentFromThirdPartySenderId(nick).then((intent) => {
	      return intent.leave(roomId);
	    });
	  }
	}
      });
      for (var nick in nicks) {
	if (!nicks.hasOwnProperty(nick)) continue;
	if (nick === client.nick) continue;
	app.getIntentFromThirdPartySenderId(nick).then((intent) => {
	  return matrixRoomIdFuture.then((roomId) => {
	    intent.join(roomId)
	  });
	});
      }
    });

    client.on('topic', function (chan, topic, nick) {
      Promise.join(
	  app.getOrCreateMatrixRoomFromThirdPartyRoomId(chan),
	  app.getIntentFromThirdPartySenderId(nick),
	  function(matrixRoomId, intent) {
	    intent.setRoomTopic(matrixRoomId, topic);
	  }
      );
    });

    client.on('join', function (chan, nick) {
      Promise.join(
	  app.getOrCreateMatrixRoomFromThirdPartyRoomId(chan),
	  app.getIntentFromThirdPartySenderId(nick),
	  function(matrixRoomId, intent) {
	    intent.join(matrixRoomId);
	  }
      );
    });

    client.on('part', function (chan, nick, reason) {
      Promise.join(
	  app.getOrCreateMatrixRoomFromThirdPartyRoomId(chan),
	  app.getIntentFromThirdPartySenderId(nick),
	  function(matrixRoomId, intent) {
	    intent.leave(matrixRoomId)
	  }
      );
    });

    client.on('quit', function (nick, reason, chans) {
      for (let chan of chans) {
	Promise.join(
	    app.getOrCreateMatrixRoomFromThirdPartyRoomId(chan),
	    app.getIntentFromThirdPartySenderId(nick),
	    function(matrixRoomId, intent) {
	      intent.leave(matrixRoomId)
	    }
	);
      }
    });

    client.on('kick', function (chan, nick, by, reason) {
      // TODO: what if we are kicked?
      const isMe = nick === client.nick;
      if (isMe) {
      }

      var nickId = app.getGhostUserFromThirdPartySenderId(nick);
      Promise.join(
	  app.getOrCreateMatrixRoomFromThirdPartyRoomId(chan),
	  app.getIntentFromThirdPartySenderId(by),
	  function(matrixRoomId, intent) {
	    intent.kick(matrixRoomId, nickId);
	  }
      );
    });

    client.on('message#', function (nick, chan, text) {
      const isMe = nick === client.nick;
      
      var roomPromise = app.getOrCreateMatrixRoomFromThirdPartyRoomId(chan);
      return app.handleThirdPartyRoomMessage({
	roomId: chan,
	senderName: nick,
	senderId: isMe ? undefined : nick,
	text
      }).catch(err => {
	console.error(err.stack);
      }).then(function(result) {
	if (readOnUnaway && !isAway) {
	  var intent = new Intent(app.puppet.getClient(), null, {registered: true});
	  roomPromise.then(function(roomId) {
	    intent.sendReadReceipt(roomId, result.event_id);
	  });
	}
      });
    });

    client.on('pm', function (nick, text) {
      return app.sendStatusMsg({}, "PM " + nick + ": " + text);
    });

    client.on('notice', function (nick, to, text) {
      if (to === client.nick) {
	return app.sendStatusMsg({}, "NOTICE " + nick + ": " + text);
      }
      const isMe = nick === client.nick;
      return app.handleThirdPartyRoomMessage({
	roomId: to,
	senderName: nick,
	senderId: isMe ? undefined : nick,
	text: "(notice) " + text
      }).catch(err => {
	console.error(err.stack);
      }).then(function(result) {
	if (readOnUnaway && !isAway) {
	  var intent = new Intent(app.puppet.getClient(), null, {registered: true});
	  roomPromise.then(function(roomId) {
	    intent.sendReadReceipt(roomId, result.event_id);
	  });
	}
      });
    });

    client.on('nick', function (oldnick, newnick, chans) {
      var oldIntentPromise = app.getIntentFromThirdPartySenderId(oldnick);
      var newIntentPromise = app.getIntentFromThirdPartySenderId(newnick);
      for (let chan of chans) {
	app.getOrCreateMatrixRoomFromThirdPartyRoomId(chan).then((matrixRoomId) => {
	  oldIntentPromise.then((oldIntent) => {
	    oldIntent.leave(matrixRoomId);
	  });
	  newIntentPromise.then((newIntent) => {
	    newIntent.join(matrixRoomId);
	  });
	});
      }
    });

    client.on('invite', function (chan, from) {
      return app.sendStatusMsg({}, from + " invites you to " + chan);
    });

    client.on('action', function (nick, to, text) {
      var formatted = " * " + nick + " " + text;
      if (to === client.nick) {
	return app.sendStatusMsg({}, "PM " + formatted);
      }
      const isMe = nick === client.nick;
      return app.handleThirdPartyRoomMessage({
	roomId: to,
	senderName: nick,
	senderId: isMe ? undefined : nick,
	text: formatted
      }).catch(err => {
	console.error(err.stack);
      }).then(function(result) {
	if (readOnUnaway && !isAway) {
	  var intent = new Intent(app.puppet.getClient(), null, {registered: true});
	  roomPromise.then(function(roomId) {
	    intent.sendReadReceipt(roomId, result.event_id);
	  });
	}
      });
    });

    client.on('raw', function (msg) {
      if (msg.command === 'rpl_nowaway') {
	isAway = true;
      } else if (msg.command === 'rpl_unaway') {
	isAway = false;
      }
    });
    console.log('Subscribed to IRC events');
    //});
    return Promise.resolve();
  }
  getPuppetThirdPartyUserId() {
    return this.client.nick;
  }
  sendMessageAsPuppetToThirdPartyRoomWithId(id, text) {
    this.client.say(id, text);
    return Promise.resolve();
  }
  getStatusRoomPostfix() {
    return this.config.irc.servicePrefix + "StatusRoom";
  }
  getThirdPartyUserDataById(userId) {
    return Promise.promisify(this.client.whois)(userId).then((whoisdata) => {
      console.log("Whois:", whoisdata);
      return {};
    });
  }
  getThirdPartyRoomDataById(roomId) {
    return Promise.resolve(this.client.chans[roomId].topic || "");
  }
  sendReadReceiptAsPuppetToThirdPartyRoomWithId(roomId) {
    return Promise.resolve();
  }
}

new Cli({
  port: config.port,
  registrationPath: config.registrationPath,
  generateRegistration: function(reg, callback) {
    puppet.associate().then(()=>{
      reg.setId(AppServiceRegistration.generateToken());
      reg.setHomeserverToken(AppServiceRegistration.generateToken());
      reg.setAppServiceToken(AppServiceRegistration.generateToken());
      reg.setSenderLocalpart(config.irc.servicePrefix + "bot");
      reg.addRegexPattern("users", "@" + config.irc.servicePrefix + "_.*", true);
      reg.addRegexPattern("aliases", "#" + config.irc.servicePrexix + "_.*", true);
      callback(reg);
    }).catch(err=>{
      console.error(err.message);
      process.exit(-1);
    });
  },
  run: function(port) {
    const app = new App(config, puppet);
    return puppet.startClient().then(()=>{
      return app.initThirdPartyClient();
    }).then(() => {
      return app.bridge.run(port, config);
    }).then(()=>{
      console.log('Matrix-side listening on port %s', port);
    }).catch(err=>{
      console.error(err.message);
      process.exit(-1);
    });
  }
}).run();

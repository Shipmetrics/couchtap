'use strict';

var util       = require('util');
var events     = require('events');
var sasl       = require('saslmechanisms');
var sasl_plain = require('sasl-plain');
var Int64      = require('node-int64');

var factory    = require('./factory.js');
var Connection = require('./connection.js');

// Init SASL Factory
var sasl_factory = new sasl.Factory();
sasl_factory.use(sasl_plain);
var sasl_plain = sasl_factory.create(['PLAIN']);


function Client(opts) {
  this.opts = opts;
  this._connected = false;
  this._conn = new Connection();
  this._conn.on('connect', this._onConnect.bind(this));
  this._conn.on('error', this._onError.bind(this));
  this._conn.on('close', this._onClose.bind(this));
  this._conn.on('data', this._onData.bind(this));
  this._conn.on('end', this._onEnd.bind(this));
  if (this.opts.connect === true)
    setImmediate(this.connect.bind(this));
}

util.inherits(Client, events.EventEmitter);

/********************************** Methods ***********************************/

Client.prototype.connect = function() {
  this._conn.connect({
    host: this.opts.host,
    port: this.opts.port || 11210
  });
};

Client.prototype.close = function() {
  this._conn.close();
};

/********************************** Events ***********************************/


Client.prototype._onConnect = function() {
  this._requestSASLMechs();
};

Client.prototype._onError = function(err) {
  this._connected = false;
  this.emit('error', err);
};

Client.prototype._onClose = function() {
  this._connected = false;
  this.emit('close');
};

Client.prototype._onData = function(header, extras, key, body) {
  this.emit('data', header, extras, key, body);
  var opcode = header.opcode;
  if (Client.handlers[header.opcode])
    Client.handlers[header.opcode].call(this, header, extras, key, body);
};

Client.prototype._onEnd = function(err) {
  this._connected = false;
  this.emit('end');
};

/**************************** Outgoing datagrams *****************************/


/* SASL Mechanisms */
Client.prototype._requestSASLMechs = function() {
  var header = factory.createHeader();
  header.magic  = 0x80;
  header.opcode = 0x20;
  this._conn.send(header);
};

Client.prototype._requestSASLAuth = function(mechs) {
  var key  = new Buffer('PLAIN');
  var body = new Buffer(sasl_plain.response({
    username: this.opts.bucket, 
    password: this.opts.password
  }));
  var header = factory.createHeader();
  header.magic = 0x80;
  header.opcode = 0x21;
  header.keyLength = key.length;
  header.dataLength = key.length + body.length;

  this._conn.send(header, key, body);
};

/* Set TAP Mode */
Client.prototype.setMode = function(mode) {
  if (!this._connected) { return; }
  this.mode = mode;

  var extras = factory.createUInt32BE(
    (mode.backfill   ? 0x01 : 0) |
    (mode.dump       ? 0x02 : 0) |
    (mode.vbuckets   ? 0x04 : 0) |
    (mode.takover    ? 0x08 : 0) |
    (mode.enableAcks ? 0x10 : 0) |
    (mode.keysOnly   ? 0x20 : 0) |
    (mode.registred  ? 0x80 : 0)
  );

  var key = new Buffer(this.opts.name || 0);

  var chunks = [];
  if (mode.backfill) {
    chunks.push((new Int64(mode.backfill)).buffer);
  }
  if (mode.vbuckets) {
    chunks.push(factory.createUInt16BE(mode.vbuckets.length));
    mode.vbuckets.forEach(function (vbucket) {
      chunks.push(factory.createUInt16BE(vbucket));
    });
  }
  var body = Buffer.concat(chunks);

  var header = factory.createHeader();
  header.magic        = 0x80;
  header.opcode       = 0x40;
  header.extrasLength = extras.length;
  header.keyLength    = key.length;
  header.dataLength   = (extras.length + key.length + body.length);

  this._conn.send(header, extras, key, body);
};

/**************************** Incoming datagrams *****************************/

/* SASL Authentification Response */
Client.prototype._handleSASLAuth = function(header, extras, key, body) {
  var status = body.toString('utf8');
  // console.log('[cli][authed]', status);
  if (status == '') {
    this._connected = true;
    if (this.opts.mode)
      this.setMode(this.opts.mode);
    this.emit('connect');
  }
  else {
    this._onError(new Error(status));
    this._conn.close();
  }
};

/* SASL Mechs Response */
Client.prototype._handleSASLMechs = function(header, extras, key, body) {
  var mechs = extras.toString('ascii').split(' ');
  this._requestSASLAuth(mechs);
};

/* Mutation */
Client.prototype._handleMutation = function(header, extras, key, body) {
  var misc     = {
    header: header.toObject(),
    extras: {
      engine    : extras.readUInt16BE(0),
      flags     : extras.readUInt16BE(2),
      ttl       : extras.readUInt8(4),
      reserved  : extras.slice(5,8),
      itemFlags : extras.readUInt32BE(8),
      itemExpiry: extras.readUInt32BE(12)
    }
  };
  var metaLength = misc.extras.engine;
  var metas = key.slice(0, metaLength);
  key = Buffer.concat([
    key.slice(metaLength, key.length),
    body.slice(0, metaLength)
  ]).toString('utf8');
  body = body.slice(metaLength).toString('utf8');
  this.emit('mutation', metas, key, body, misc);
};

/* Delete */
Client.prototype._handleDelete = function(header, extras, key, body) {
  var misc     = {
    header: header.toObject(),
    extras: {
      engine    : extras.readUInt16BE(0),
      flags     : extras.readUInt16BE(2),
      ttl       : extras.readUInt8(4),
      reserved  : extras.slice(5,8),
    }
  };
  var metaLength = misc.extras.engine;
  var metas = key.slice(0, metaLength);
  key = Buffer.concat([
    key.slice(metaLength, key.length),
    body.slice(0, metaLength)
  ]).toString('utf8');

  this.emit('delete', metas, key, misc);
};

/* Flush */
Client.prototype._handleFlush = function(header, extras, key, body) {
  var misc     = {
    header: header.toObject(),
    extras: {
      engine    : extras.readUInt16BE(0),
      flags     : extras.readUInt16BE(2),
      ttl       : extras.readUInt8(4),
      reserved  : extras.slice(5,8),
    }
  };
  this.emit('flush', misc);
};

/* Opaque */
Client.prototype._handleOpaque = function(header, extras, key, body) {
  var misc     = {
    header: header.toObject(),
    extras: {
      engine    : extras.readUInt16BE(0),
      flags     : extras.readUInt16BE(2),
      ttl       : extras.readUInt8(4),
      reserved  : extras.slice(5,8),
    }
  };
  var _flags = body.readUInt32BE(0);
  var flags =   {
    enableAcks        : !!(_flags & 1),
    startBackfill     : !!(_flags & 2),
    enableCheckpoints : !!(_flags & 4),
    openChekpoint     : !!(_flags & 8),
    startOnlineUpdate : !!(_flags & 16),
    stopOnlineUpdate  : !!(_flags & 32),
    closeStream       : !!(_flags & 64),
    closeBackfill     : !!(_flags & 128)
  };
  this.emit('opaque', flags, misc);
};


Client.handlers = {
  0x20: Client.prototype._handleSASLMechs, 
  0x21: Client.prototype._handleSASLAuth, 
  0x41: Client.prototype._handleMutation, 
  0x42: Client.prototype._handleDelete, 
  0x43: Client.prototype._handleFlush, 
  0x44: Client.prototype._handleOpaque,
};



module.exports = Client;

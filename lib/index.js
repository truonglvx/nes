'use strict';

// Load modules

const Cryptiles = require('cryptiles');
const Hoek = require('hoek');
const Iron = require('iron');
const Items = require('items');
const Joi = require('joi');
const Ws = require('ws');
const Client = require('./client');
const Listener = require('./listener');


// Declare internals

const internals = {
    defaults: {
        auth: {
            endpoint: '/nes/auth',
            id: 'nes.auth',
            type: 'direct',
            cookie: 'nes',
            isSecure: true,
            isHttpOnly: true,
            path: '/',
            index: false,
            timeout: 5000,                                  // 5 seconds
            maxConnectionsPerUser: false
        },
        headers: null,
        payload: {
            maxChunkChars: false
        },
        heartbeat: {
            interval: 15000,                                // 15 seconds
            timeout: 5000                                   // 5 seconds
        },
        maxConnections: false
    }
};


internals.schema = Joi.object({
    onConnection: Joi.func(),                               // function (socket) {}
    onDisconnection: Joi.func(),                             // function (socket) {}
    onMessage: Joi.func(),                                  // function (socket, message, next) { return next(data); }
    auth: Joi.object({
        endpoint: Joi.string().required(),
        id: Joi.string(),
        type: Joi.valid('cookie', 'token', 'direct').required(),
        route: [
            Joi.object(),
            Joi.string()
        ],
        cookie: Joi.string().required(),
        isSecure: Joi.boolean(),
        isHttpOnly: Joi.boolean(),
        path: Joi.string().allow(null),
        domain: Joi.string().allow(null),
        ttl: Joi.number().allow(null),
        iron: Joi.object(),
        password: Joi.alternatives([
            Joi.string(),
            Joi.binary(),
            Joi.object()
        ]),
        index: Joi.boolean(),
        timeout: Joi.number().integer().min(1).allow(false),
        maxConnectionsPerUser: Joi.number().integer().min(1).allow(false).when('index', { is: true, otherwise: Joi.valid(false) })
    })
        .allow(false)
        .required(),
    headers: Joi.array().items(Joi.string().lowercase()).min(1).allow('*', null),
    payload: {
        maxChunkChars: Joi.number().integer().min(1).allow(false)
    },
    heartbeat: Joi.object({
        interval: Joi.number().integer().min(1).required(),
        timeout: Joi.number().integer().min(1).less(Joi.ref('interval')).required()
    })
        .allow(false),
    maxConnections: Joi.number().integer().min(1).allow(false),
    origin: Joi.array().items(Joi.string()).single().min(1)
});


exports.register = function (server, options, next) {

    const settings = Hoek.applyToDefaults(internals.defaults, options);
    Joi.assert(settings, internals.schema, 'Invalid nes configuration');

    if (Array.isArray(settings.headers)) {
        settings.headers = settings.headers.map((field) => field.toLowerCase());
    }

    // Authentication endpoint

    internals.auth(server, settings);

    // Create a listener per connection

    const listeners = [];

    const connections = server.connections;
    for (let i = 0; i < connections.length; ++i) {
        listeners.push(new Listener(connections[i], settings));              // Constructor registers with connection
    }

    // Clear stopped state if restarted

    const onPreStart = function (srv, extNext) {

        for (let i = 0; i < listeners.length; ++i) {
            listeners[i]._stopped = false;
        }

        return extNext();
    };

    server.ext('onPreStart', onPreStart);

    // Stop connections when server stops

    const onPreStop = function (srv, extNext) {

        Items.serial(listeners, (listener, nextListener) => listener._close(nextListener), extNext);
    };

    server.ext('onPreStop', onPreStop);

    // Decorate server and request

    server.decorate('server', 'broadcast', Listener.broadcast);
    server.decorate('server', 'subscription', Listener.subscription);
    server.decorate('server', 'publish', Listener.publish);
    server.decorate('server', 'eachSocket', Listener.eachSocket);
    server.decorate('request', 'socket', internals.socket, { apply: true });

    return next();
};

exports.register.attributes = {
    pkg: require('../package.json')
};


Client.Client.WebSocket = Ws;
exports.Client = Client.Client;


internals.auth = function (server, settings) {

    const config = settings.auth;
    if (!config) {
        return;
    }

    if (config.type !== 'direct' &&
        !config.password) {

        config.password = Cryptiles.randomString(32);
    }

    if (config.type === 'cookie') {
        const cookieOptions = {
            isSecure: config.isSecure,
            isHttpOnly: config.isHttpOnly,
            path: config.path,
            domain: config.domain,
            ttl: config.ttl,
            encoding: 'iron',
            password: config.password,
            iron: config.iron
        };

        server.state(config.cookie, cookieOptions);
    }

    server.route({
        method: (config.type === 'direct' ? 'auth' : 'GET'),
        path: config.endpoint,
        config: {
            id: config.id,
            isInternal: (config.type === 'direct'),
            auth: config.route,
            handler: function (request, reply) {

                if (!request.auth.isAuthenticated) {
                    return reply({ status: 'unauthenticated' });
                }

                const credentials = {
                    credentials: request.auth.credentials,
                    artifacts: request.auth.artifacts
                };

                if (config.type === 'direct') {
                    return reply(credentials);
                }

                const result = { status: 'authenticated' };

                if (config.type === 'cookie') {
                    return reply(result).state(config.cookie, credentials);
                }

                Iron.seal(credentials, config.password, config.iron || Iron.defaults, (err, sealed) => {

                    if (err) {
                        return reply(err);
                    }

                    result.token = sealed;
                    return reply(result);
                });
            }
        }
    });
};


internals.socket = function (request) {

    return (request.plugins.nes ? request.plugins.nes.socket : null);
};

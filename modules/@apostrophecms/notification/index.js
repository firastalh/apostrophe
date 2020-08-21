// This module provides a framework for triggering notifications
// within the Apostrophe admin UI. Notifications may be triggered
// either on the browser or the server side, via `apos.notice`.
//
// ## Options
//
// ### `queryInterval`: interval in milliseconds between MongoDB
// queries while long polling for notifications. Defaults to 1000
// (1 second). Set it longer if you prefer fewer queries, however
// these are indexed queries on a small amount of information and
// should not significantly impact your app.
//
// ### `longPollingTimeout`: maximum lifetime in milliseconds of a long
// polling HTTP request before a response with no notifications is sent.
// Defaults to 10000 (10 seconds) to avoid typical proxy server timeouts.
// Until it times out the request will keep making MongoDB queries to
// see if any new notifications are available (long polling).

const Promise = require('bluebird');
const _ = require('lodash');
const url = require('url');

module.exports = {
  options: {
    alias: 'notification'
  },
  extend: '@apostrophecms/module',
  async init(self, options) {
    self.apos.notify = self.trigger;
    await self.ensureCollection();
    self.enableBrowserData();
  },
  restApiRoutes: (self, options) => ({
    getOne(req, _id) {
      return self.find(req, { displayingIds: [_id] });
    },
    async post(req) {
      const type = self.apos.launder.select(req.body.type, [
        'error',
        'warn',
        'success',
        'info'
      ], 'info');
      const message = self.apos.launder.string(req.body.message);
      const strings = self.apos.launder.strings(req.body.strings);
      const dismiss = self.apos.launder.integer(req.body.dismiss);
      const pulse = self.apos.launder.boolean(req.body.pulse);
      const id = self.apos.launder.id(req.body.id);
      await self.trigger.apply(self, [
        req,
        message
      ].concat(strings).concat([{
        dismiss,
        type,
        pulse,
        id
      }]));
      return self.trigger(req, req.body.message, req.body.options || {});
    },
    put(req, _id) {
      throw self.apos.error('unimplemented');
    },
    patch(req, _id) {
      throw self.apos.error('unimplemented');
    },
    delete(req, _id) {
      return self.db.deleteMany({ _id });
    }
  }),
  methods(self, options) {
    return {
      getBrowserData(req) {
        return {
          action: self.action
        };
      },
      // Call with `req`, then a message, followed by any interpolated strings
      // which must correspond to %s placeholders in `message` (variable number
      // of arguments), followed by an `options` object if desired.
      //
      // If you do not have a `req` it is acceptable to pass a user `_id` string
      // in place of `req`. Someone must be the recipient.
      //
      // `options.type` styles the notification and may be set to `error`,
      // `warn` or `success`. If not set, a "plain" default style is used.
      //
      // If `options.dismiss` is set to `true`, the message will auto-dismiss after 5 seconds.
      // If it is set to a number of seconds, it will dismiss after that number of seconds.
      // Otherwise it will not dismiss unless clicked.
      //
      // The message is internationalized, which is why the use of
      // %s placeholders for any inserted titles, etc. is important.
      //
      // Throws an error if there is no `req.user`.
      //
      // This method is aliased as `apos.notify` for convenience.
      //
      // The method is async, and you may `await` to be certain the
      // notification has reached the database, but this is not mandatory.
      // It is a good idea when triggering a notification just before exiting
      // the application, as in a command line task.

      async trigger(req, message, options) {
        if (typeof req === 'string') {
          // String was passed, assume it is a user _id
          req = { user: { _id: req } };
        }
        if (!req.user) {
          throw self.apos.error('forbidden');
        }
        if (!message) {
          throw self.apos.error('required');
        }
        let strings = [];
        let i = 2;
        let index = 0;
        while (true) {
          index = message.indexOf('%s', index);
          if (index === -1) {
            break;
          }
          // Don't match the same one over and over
          index += 2;
          if (i >= arguments.length || typeof arguments[i] === 'object') {
            throw new Error('Bad notification call: number of %s placeholders does not match number of string arguments after message');
          }
          strings.push(arguments[i++]);
        }
        if (i === arguments.length - 1 && typeof arguments[i] === 'object') {
          options = arguments[i++];
        } else {
          options = {};
        }

        if (i !== arguments.length) {
          throw new Error('Bad notification call: number of %s placeholders does not match number of string arguments after message');
        }

        let notification = {
          _id: self.apos.util.generateId(),
          createdAt: new Date(),
          userId: req.user._id,
          message,
          strings
        };

        if (options.dismiss === true) {
          options.dismiss = 5;
        }

        Object.assign(notification, options);

        return self.db.insertOne(notification);
      },

      // Resolves with an object with `notifications` and `dismissed`
      // properties.
      //
      // If `options.displayingIds` is set, notifications
      // whose `_id` properties appear in it are not returned.

      async find(req, options) {
        try {
          const notifications = await self.db.find({
            userId: req.user._id,
            createdAt: { $gt: new Date(options.latest) },
            modifiedSince: { $exists: false }
          }).sort({ createdAt: 1 }).toArray();
          return {
            notifications: _.filter(notifications, function (notification) {
              if (options.displayingIds && options.displayingIds.length > 0) {
                return !_.includes(options.displayingIds || [], notification._id);
              }
              return notification;
            }),
            dismissed: _.difference(options.displayingIds || [], _.map(notifications, '_id'))
          };
        } catch (err) {
          if (self.apos.db.closed) {
            // The database connection was intentionally closed,
            // which often triggers a race condition with
            // long polling requests. Send an empty response
            return {
              notifications: [],
              dismissed: []
            };
          } else {
            throw err;
          }
        }
      },

      async update(req, notifications) {
        const ids = notifications.map(notification => notification._id);
        await self.db.updateMany(
          { userId: req.user._id, _id: { $in: ids } },
          { $currentDate: { modifiedSince: { $type: 'timestamp' } } }
        );
      },

      async ensureCollection() {
        self.db = self.apos.db.collection('aposNotifications');
        return self.db.createIndex({
          userId: 1,
          createdAt: 1
        });
      }
    };
  },
  middleware(self, options) {
    return {
      // This middleware is essentially a POST route at
      // `/api/v1/@apostrophecms/notification/poll`. It is implemented
      // as middleware to allow it to run before `req.data.global` is loaded,
      // which can be a very expensive operation on some sites and should
      // thus not be required before a high-frequency polling operation.
      //
      // Poll for active notifications. Responds with:
      //
      // `{ status: 'ok', notifications: [ ... ], dismissed: [ id1... ] }`
      //
      // Each notification has an `html` property containing
      // its rendered, localized markup, as well as `_id`, `createdAt`
      // and `id` (if one was provided when it was triggered).
      //
      // The client must provide `req.body.displayingIds`,
      // an array of notification `_id` properties it is already displaying.
      // Without this, all notifications that have not been dismissed via the
      // dismiss route are sent.
      //
      // If any of the ids in `displayingIds` have been recently dismissed,
      // the response will include them in its `dismissed` property.
      //
      // Waits up to 10 seconds for new notifications (long polling),
      // but then respond with an empty array to avoid proxy server timeouts.
      //
      // As usual POST is used to avoid unwanted caching of the response.
      notifications: {
        before: '@apostrophecms/global',
        middleware: async (req, res, next) => {
          let start;
          let latest;
          try {
            const pathname = url.parse(req.url).pathname; //TODO: replace by new URL
            if (req.method.toUpperCase() !== 'GET' || pathname !== self.action) {
              return next();
            }
            if (!(req.user && req.user._id)) {
              throw self.apos.error('invalid');
            }
            start = Date.now();
            latest = self.apos.launder.date(req.query.latest);
            await attempt();
          } catch (e) {
            return self.apos.error(res, e);
          }

          async function attempt() {
            if (Date.now() - start >= (self.options.longPollingTimeout || 10000)) {
              return {
                notifications: [],
                dismissed: []
              };
            }
            const result = await self.find(req, { latest });
            const notifications = result.notifications;
            const dismissed = result.dismissed;
            await self.update(req, notifications);

            if (!notifications.length && !dismissed.length) {
              await Promise.delay(self.options.queryInterval || 1000);
              return attempt();
            }

            return res.send({
              notifications: notifications,
              dismissed: dismissed
            });
          }
        }
      }
    };
  }
};

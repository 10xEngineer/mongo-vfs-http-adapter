var urlParse = require('url').parse;
var multipart = require('./multipart');
var Stream = require('stream').Stream;
var pathJoin = require('path').join;

module.exports = function setup(mount, vfs, mountOptions) {

  if (!mountOptions) mountOptions = {};

  // Returns a json stream that wraps input object stream
  function jsonEncoder(input, path) {
    var output = new Stream();
    output.readable = true;
    var first = true;
    input.on("data", function (entry) {
      if (path) {
        entry.href = path + entry.name;
        var mime = entry.linkStat ? entry.linkStat.mime : entry.mime;
        if (mime.match(/(directory|folder)$/)) {
          entry.href += "/";
        }
      }
      if (first) {
        output.emit("data", "[\n  " + JSON.stringify(entry));
        first = false;
      } else {
        output.emit("data", ",\n  " + JSON.stringify(entry));
      }
    });
    input.on("end", function () {
      if (first) output.emit("data", "[]");
      else output.emit("data", "\n]");
      output.emit("end");
    });
    if (input.pause) {
      output.pause = function () {
        input.pause();
      };
    }
    if (input.resume) {
      output.resume = function () {
        input.resume();
      };
    }
    return output;
  }

  return function (req, res, next) {

    if (mountOptions.readOnly && !(req.method === "GET" || req.method === "HEAD")) return next();
    if (!req.uri) { req.uri = urlParse(req.url); }

    // Get the bucket id
    // TODO: Pass on 404 error?
    if (!req.params.bucketId) return next();

    if (mount[mount.length - 1] !== "/") mount += "/";

    var path = unescape(req.uri.pathname);
    // no need to sanitize the url (remove ../..) the vfs layer has this
    // responsibility since it can do it better with realpath.
    if (path.substr(0, mount.length) !== mount) { return next(); }
    path = path.substr(mount.length - 1);

    // Instead of using next for errors, we send a custom response here.
    function abort(err, code) {
      console.error(err.stack || err);
      if (code) res.statusCode = code;
      else if (err.code === "EBADREQUEST") res.statusCode = 400;
      else if (err.code === "EACCESS") res.statusCode = 403;
      else if (err.code === "ENOENT") res.statusCode = 404;
      else if (err.code === "ENOTREADY") res.statusCode = 503;
      else res.statusCode = 500;
      var message = (err.stack || err) + "\n";
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Length", Buffer.byteLength(message));
      res.end(message);
    }

    var options = {
      bucketId: req.params.bucketId
    };
    if (req.method === "HEAD") {
      options.head = true;
      req.method = "GET";
    }

    if (req.method === "GET") {

      if (req.headers.hasOwnProperty("if-none-match")) options.etag = req.headers["if-none-match"];

      if (req.headers.hasOwnProperty('range')) {
        var range = options.range = {};
        var p = req.headers.range.indexOf('=');
        var parts = req.headers.range.substr(p + 1).split('-');
        if (parts[0].length) {
          range.start = parseInt(parts[0], 10);
        }
        if (parts[1].length) {
          range.end = parseInt(parts[1], 10);
        }
        if (req.headers.hasOwnProperty('if-range')) range.etag = req.headers["if-range"];
      }

      var tryAgain;

      if (path[path.length - 1] === "/") {
        if (mountOptions.autoIndex) {
          tryAgain = true;
          vfs.readfile(path + mountOptions.autoIndex, options, onGet);
        }
        else {
          options.encoding = null;
          vfs.readdir(path, options, onGet);
        }
      } else {
        vfs.readfile(path, options, onGet);
      }

      function onGet(err, meta) {
        res.setHeader("Date", (new Date()).toUTCString());
        if (err) {
          if (tryAgain) {
            tryAgain = false;
            options.encoding = null;
            return vfs.readdir(path, options, onGet);
          }
          return abort(err);
        }
        if (meta.rangeNotSatisfiable) return abort(meta.rangeNotSatisfiable, 416);

        if (meta.hasOwnProperty('etag')) res.setHeader("ETag", meta.etag);

        if (meta.notModified) res.statusCode = 304;
        if (meta.partialContent) res.statusCode = 206;

        if (meta.hasOwnProperty('stream') || options.head) {
          if (meta.hasOwnProperty('mime')) res.setHeader("Content-Type", meta.mime);
          if (meta.hasOwnProperty("size")) {
            res.setHeader("Content-Length", meta.size);
            if (meta.hasOwnProperty("partialContent")) {
              res.setHeader("Content-Range", "bytes " + meta.partialContent.start + "-" + meta.partialContent.end + "/" + meta.partialContent.size);
            }
          }
          if (options.encoding === null) {
            res.setHeader("Content-Type", "application/json");
          }
        }
        if (meta.hasOwnProperty('stream')) {
          meta.stream.on("error", abort);
          if (options.encoding === null) {
            var base = (req.socket.encrypted ? "https://" : "http://") + req.headers.host + pathJoin(mount, path);
            jsonEncoder(meta.stream, base).pipe(res);
          } else {
            meta.stream.pipe(res);
          }
          req.on("close", function () {
            if (meta.stream.readable) {
              meta.stream.destroy();
              meta.stream.readable = false;
            }
          })
        } else {
          res.end();
        }
      }

    } // end GET request

    else if (req.method === "PUT") {

      if (path[path.length - 1] === "/") {
        vfs.mkdir(path, options, function (err, meta) {
          if (err) return abort(err);
          res.end();
        });
      } else {
        var contentLength = req.headers['content-length'];
        var command;
        if(contentLength > 0) {
          command = vfs.writefile;
        } else {
          command = vfs.mkfile;
        }
        if(req._endEmitted) {
          options.stream = new Stream();
          options.stream.readable = true;

          // Hack to make sure end event is catched
          process.nextTick(function() {
            console.log(req.content);
            options.stream.emit('data', req.content);
            options.stream.emit('end');
          });
        } else {
          options.stream = req;
        }

        command.call(vfs, path, options, function (err, meta) {
          if (err) return abort(err);
          res.end();
        });
      }
    } // end PUT request

    else if (req.method === "DELETE") {
      var command;
      console.log(path);
      if (path[path.length - 1] === "/") {
        command = vfs.rmdir;
      } else {
        command = vfs.rmfile;
      }
      command(path, options, function (err, meta) {
        if (err) return abort(err);
        res.end();
      });
    } // end DELETE request

    else if (req.method === "POST") {

      var message = typeof(req.content) == 'string' ? JSON.parse(req.content) : req.content;

      var command;
      if (message.renameFrom) {
        command = vfs.rename;
        options.from = message.renameFrom;
      }
      else if (message.copyFrom) {
        command = vfs.copy;
        options.from = message.copyFrom;
      }
      else if (message.linkTo) {
        command = vfs.symlink;
        options.target = message.linkTo;
      }
      else {
        return abort(new Error("Invalid command in POST " + data));
      }

      command(path, options, function (err, meta) {
        if (err) return abort(err);
        res.end();
      });
    } // end POST commands
    else if (req.method === "PROPFIND") {
      vfs.stat(path, options, function (err, meta) {
        if (err) return abort(err);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(meta) + "\n");
      });
    }
    else {
      return abort("Unsupported HTTP method", 501);
    }

  };

};


(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/*
 * Federated Wiki : Social Security Plugin
 *
 * Licensed under the MIT license.
 * https://github.com/fedwiki/wiki-security-social/blob/master/LICENSE.txt
 */
/*
1. Display login button - if there is no authenticated user
2. Display logout button - if the user is authenticated

3. When user authenticated, claim site if unclaimed - and repaint footer.

*/
var WinChan, claim_wiki, settings, setup, update_footer;

WinChan = require('./winchan.js');

settings = {};

claim_wiki = function() {
  var myInit;
  if (!isClaimed) {
    // only try and claim if we think site is unclaimed
    myInit = {
      method: 'GET',
      cache: 'no-cache',
      mode: 'same-origin',
      credentials: 'include'
    };
    return fetch('/auth/claim-wiki', myInit).then(function(response) {
      if (response.ok) {
        return response.json().then(function(json) {
          var ownerName;
          if (wiki.lineup.bestTitle() === 'Login Required') {
            return location.reload();
          } else {
            ownerName = json.ownerName;
            window.isClaimed = true;
            window.isOwner = true;
            return update_footer(ownerName, true);
          }
        });
      } else {
        return console.log('Attempt to claim site failed', response);
      }
    });
  }
};

update_footer = function(ownerName, isAuthenticated) {
  var logoutIconClass, logoutTitle, signonTitle;
  // we update the owner and the login state in the footer, and
  // populate the security dialog
  if (ownerName) {
    $('footer > #site-owner').html(`Wiki by: <span id='site-owner'>${ownerName}</span>`);
  }
  $('footer > #security').empty();
  if (isAuthenticated) {
    if (isOwner) {
      logoutTitle = "Sign-out";
      logoutIconClass = 'fa fa-unlock fa-lg fa-fw';
    } else {
      logoutTitle = "Not Owner : Sign-out";
      logoutIconClass = 'fa fa-lock fa-lg fa-fw notOwner';
    }
    $('footer > #security').append(`<a href='#' id='logout' class='footer-item' title='${logoutTitle}'><i class='${logoutIconClass}'></i></a>`);
    $('footer > #security > #logout').on('click', function(e) {
      var myInit;
      e.preventDefault();
      myInit = {
        method: 'GET',
        cache: 'no-cache',
        mode: 'same-origin',
        credentials: 'include'
      };
      return fetch('/logout', myInit).then(function(response) {
        var user;
        if (response.ok) {
          window.isAuthenticated = false;
          user = '';
          document.cookie = "state=loggedOut" + ";domain=." + settings.cookieDomain + "; path=/; max-age=60; sameSite=Strict;";
          return update_footer(ownerName, isAuthenticated);
        } else {
          return console.log('logout failed: ', response);
        }
      });
    });
    if (!isClaimed) {
      $('footer > #security').append("<a href='#' id='claim' class='foot-item' title='Claim this Wiki'><i class='fa fa-key fa-lg fa-fw'></i></a>");
      return $('footer > #security > #claim').on('click', function(e) {
        e.preventDefault();
        return claim_wiki();
      });
    }
  } else {
    if (!isClaimed) {
      signonTitle = 'Claim this Wiki';
    } else {
      signonTitle = 'Wiki Owner Sign-on';
    }
    $('footer > #security').append(`<a href='#' id='show-security-dialog' class='footer-item' title='${signonTitle}'><i class='fa fa-lock fa-lg fa-fw'></i></a>`);
    return $('footer > #security > #show-security-dialog').on('click', function(e) {
      var w;
      e.preventDefault();
      document.cookie = `wikiName=${window.location.host}` + `;domain=.${settings.cookieDomain}; path=/; max-age=300; sameSite=Strict;`;
      return w = WinChan.open({
        url: settings.dialogURL,
        relay_url: settings.relayURL,
        window_features: "menubar=0, location=0, resizable=0, scrollbars=1, status=0, dialog=1, width=700, height=375",
        params: {}
      }, function(err, r) {
        if (err) {
          return console.log(err);
        } else {
          window.isAuthenticated = true;
          if (!isClaimed) {
            return claim_wiki();
          } else {
            if (wiki.lineup.bestTitle() === 'Login Required') {
              return location.reload();
            } else {
              return update_footer(ownerName, true);
            }
          }
        }
      });
    });
  }
};

setup = function(user) {
  var lastCookie, myInit;
  if (!$("link[href='https://maxcdn.bootstrapcdn.com/font-awesome/4.5.0/css/font-awesome.min.css']").length) {
    $('<link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/font-awesome/4.5.0/css/font-awesome.min.css">').appendTo("head");
  }
  // signon could happen in a different window, so listen for cookie changes
  lastCookie = document.cookie;
  window.setInterval(function() {
    var currentCookie, myInit;
    currentCookie = document.cookie;
    if (currentCookie !== lastCookie) {
      console.log("Cookie changed");
      if (document.cookie.match('(?:^|;)\\s?state=(.*?)(?:;|$)') !== null) {
        try {
          switch (document.cookie.match('(?:^|;)\\s?state=(.*?)(?:;|$)')[1]) {
            case 'loggedIn':
              window.isAuthenticated = true;
              break;
            case 'loggedOut':
              window.isAuthenticated = false;
          }
          myInit = {
            method: 'GET',
            cache: 'no-cache',
            mode: 'same-origin'
          };
          fetch('/auth/client-settings.json', myInit).then(function(response) {
            return response.json().then(function(json) {
              window.isOwner = json.isOwner;
              return update_footer(ownerName, isAuthenticated);
            });
          });
        } catch (error) {}
      }
      return lastCookie = currentCookie;
    }
  }, 100);
  if (!$("link[href='/security/style.css']").length) {
    $('<link rel="stylesheet" href="/security/style.css">').appendTo("head");
  }
  myInit = {
    method: 'GET',
    cache: 'no-cache',
    mode: 'same-origin'
  };
  return fetch('/auth/client-settings.json', myInit).then(function(response) {
    if (response.ok) {
      return response.json().then(function(json) {
        var dialogHost, dialogProtocol;
        window.isOwner = json.isOwner;
        settings = json;
        if (settings.wikiHost) {
          dialogHost = settings.wikiHost;
        } else {
          dialogHost = window.location.hostname;
        }
        settings.cookieDomain = dialogHost;
        if (settings.useHttps) {
          dialogProtocol = 'https:';
        } else {
          dialogProtocol = window.location.protocol;
          if (window.location.port) {
            dialogHost = dialogHost + ':' + window.location.port;
          }
        }
        settings.dialogURL = dialogProtocol + '//' + dialogHost + '/auth/loginDialog';
        settings.relayURL = dialogProtocol + '//' + dialogHost + '/auth/relay.html';
        settings.dialogAddAltURL = dialogProtocol + '//' + dialogHost + '/auth/addAuthDialog';
        return update_footer(ownerName, isAuthenticated);
      });
    } else {
      return console.log('Unable to fetch client settings: ', response);
    }
  });
};

window.plugins.security = {setup, claim_wiki, update_footer};


},{"./winchan.js":2}],2:[function(require,module,exports){
var WinChan = (function() {
  var RELAY_FRAME_NAME = "__winchan_relay_frame";
  var CLOSE_CMD = "die";

  // a portable addListener implementation
  function addListener(w, event, cb) {
    if(w.attachEvent) w.attachEvent('on' + event, cb);
    else if (w.addEventListener) w.addEventListener(event, cb, false);
  }

  // a portable removeListener implementation
  function removeListener(w, event, cb) {
    if(w.detachEvent) w.detachEvent('on' + event, cb);
    else if (w.removeEventListener) w.removeEventListener(event, cb, false);
  }


  // checking for IE8 or above
  function isInternetExplorer() {
    var rv = -1; // Return value assumes failure.
    var ua = navigator.userAgent;
    if (navigator.appName === 'Microsoft Internet Explorer') {
      var re = new RegExp("MSIE ([0-9]{1,}[\.0-9]{0,})");
      if (re.exec(ua) != null)
        rv = parseFloat(RegExp.$1);
    }
    // IE > 11
    else if (ua.indexOf("Trident") > -1) {
      var re = new RegExp("rv:([0-9]{2,2}[\.0-9]{0,})");
      if (re.exec(ua) !== null) {
        rv = parseFloat(RegExp.$1);
      }
    }

    return rv >= 8;
  }

  // checking Mobile Firefox (Fennec)
  function isFennec() {
    try {
      // We must check for both XUL and Java versions of Fennec.  Both have
      // distinct UA strings.
      var userAgent = navigator.userAgent;
      return (userAgent.indexOf('Fennec/') != -1) ||  // XUL
             (userAgent.indexOf('Firefox/') != -1 && userAgent.indexOf('Android') != -1);   // Java
    } catch(e) {}
    return false;
  }

  // feature checking to see if this platform is supported at all
  function isSupported() {
    return (window.JSON && window.JSON.stringify &&
            window.JSON.parse && window.postMessage);
  }

  // given a URL, extract the origin. Taken from: https://github.com/firebase/firebase-simple-login/blob/d2cb95b9f812d8488bdbfba51c3a7c153ba1a074/js/src/simple-login/transports/WinChan.js#L25-L30
  function extractOrigin(url) {
    if (!/^https?:\/\//.test(url)) url = window.location.href;
    var m = /^(https?:\/\/[\-_a-zA-Z\.0-9:]+)/.exec(url);
    if (m) return m[1];
    return url;
  }

  // find the relay iframe in the opener
  function findRelay() {
    var loc = window.location;
    var frames = window.opener.frames;
    for (var i = frames.length - 1; i >= 0; i--) {
      try {
        if (frames[i].location.protocol === window.location.protocol &&
            frames[i].location.host === window.location.host &&
            frames[i].name === RELAY_FRAME_NAME)
        {
          return frames[i];
        }
      } catch(e) { }
    }
    return;
  }

  var isIE = isInternetExplorer();

  if (isSupported()) {
    /*  General flow:
     *                  0. user clicks
     *  (IE SPECIFIC)   1. caller adds relay iframe (served from trusted domain) to DOM
     *                  2. caller opens window (with content from trusted domain)
     *                  3. window on opening adds a listener to 'message'
     *  (IE SPECIFIC)   4. window on opening finds iframe
     *                  5. window checks if iframe is "loaded" - has a 'doPost' function yet
     *  (IE SPECIFIC5)  5a. if iframe.doPost exists, window uses it to send ready event to caller
     *  (IE SPECIFIC5)  5b. if iframe.doPost doesn't exist, window waits for frame ready
     *  (IE SPECIFIC5)  5bi. once ready, window calls iframe.doPost to send ready event
     *                  6. caller upon reciept of 'ready', sends args
     */
    return {
      open: function(opts, cb) {
        if (!cb) throw "missing required callback argument";

        // test required options
        var err;
        if (!opts.url) err = "missing required 'url' parameter";
        if (!opts.relay_url) err = "missing required 'relay_url' parameter";
        if (err) setTimeout(function() { cb(err); }, 0);

        // supply default options
        if (!opts.window_name) opts.window_name = null;
        if (!opts.window_features || isFennec()) opts.window_features = undefined;

        // opts.params may be undefined

        var iframe;

        // sanity check, are url and relay_url the same origin?
        var origin = extractOrigin(opts.url);
        if (origin !== extractOrigin(opts.relay_url)) {
          return setTimeout(function() {
            cb('invalid arguments: origin of url and relay_url must match');
          }, 0);
        }

        var messageTarget;

        if (isIE) {
          // first we need to add a "relay" iframe to the document that's served
          // from the target domain.  We can postmessage into a iframe, but not a
          // window
          iframe = document.createElement("iframe");
          // iframe.setAttribute('name', framename);
          iframe.setAttribute('src', opts.relay_url);
          iframe.style.display = "none";
          iframe.setAttribute('name', RELAY_FRAME_NAME);
          document.body.appendChild(iframe);
          messageTarget = iframe.contentWindow;
        }

        var w = opts.popup || window.open(opts.url, opts.window_name, opts.window_features);
        if (opts.popup) {
          w.location.href = opts.url;
        }

        if (!messageTarget) messageTarget = w;

        // lets listen in case the window blows up before telling us
        var closeInterval = setInterval(function() {
          if (w && w.closed) {
            cleanup();
            if (cb) {
              cb('User closed the popup window');
              cb = null;
            }
          }
        }, 500);

        var req = JSON.stringify({a: 'request', d: opts.params});

        // cleanup on unload
        function cleanup() {
          if (iframe) document.body.removeChild(iframe);
          iframe = undefined;
          if (closeInterval) closeInterval = clearInterval(closeInterval);
          removeListener(window, 'message', onMessage);
          removeListener(window, 'unload', cleanup);
          if (w) {
            try {
              w.close();
            } catch (securityViolation) {
              // This happens in Opera 12 sometimes
              // see https://github.com/mozilla/browserid/issues/1844
              messageTarget.postMessage(CLOSE_CMD, origin);
            }
          }
          w = messageTarget = undefined;
        }

        addListener(window, 'unload', cleanup);

        function onMessage(e) {
          if (e.origin !== origin) { return; }
          try {
            var d = JSON.parse(e.data);
            if (d.a === 'ready') messageTarget.postMessage(req, origin);
            else if (d.a === 'error') {
              cleanup();
              if (cb) {
                cb(d.d);
                cb = null;
              }
            } else if (d.a === 'response') {
              cleanup();
              if (cb) {
                cb(null, d.d);
                cb = null;
              }
            }
          } catch(err) { }
        }

        addListener(window, 'message', onMessage);

        return {
          close: cleanup,
          focus: function() {
            if (w) {
              try {
                w.focus();
              } catch (e) {
                // IE7 blows up here, do nothing
              }
            }
          }
        };
      },
      onOpen: function(cb) {
        var o = "*";
        var msgTarget = isIE ? findRelay() : window.opener;
        if (!msgTarget) throw "can't find relay frame";
        function doPost(msg) {
          msg = JSON.stringify(msg);
          if (isIE) msgTarget.doPost(msg, o);
          else msgTarget.postMessage(msg, o);
        }

        function onMessage(e) {
          // only one message gets through, but let's make sure it's actually
          // the message we're looking for (other code may be using
          // postmessage) - we do this by ensuring the payload can
          // be parsed, and it's got an 'a' (action) value of 'request'.
          var d;
          try {
            d = JSON.parse(e.data);
          } catch(err) { }
          if (!d || d.a !== 'request') return;
          removeListener(window, 'message', onMessage);
          o = e.origin;
          if (cb) {
            // this setTimeout is critically important for IE8 -
            // in ie8 sometimes addListener for 'message' can synchronously
            // cause your callback to be invoked.  awesome.
            setTimeout(function() {
              cb(o, d.d, function(r) {
                cb = undefined;
                doPost({a: 'response', d: r});
              });
            }, 0);
          }
        }

        function onDie(e) {
          if (e.data === CLOSE_CMD) {
            try { window.close(); } catch (o_O) {}
          }
        }
        addListener(isIE ? msgTarget : window, 'message', onMessage);
        addListener(isIE ? msgTarget : window, 'message', onDie);

        // we cannot post to our parent that we're ready before the iframe
        // is loaded. (IE specific possible failure)
        try {
          doPost({a: "ready"});
        } catch(e) {
          // this code should never be exectued outside IE
          addListener(msgTarget, 'load', function(e) {
            doPost({a: "ready"});
          });
        }

        // if window is unloaded and the client hasn't called cb, it's an error
        var onUnload = function() {
          try {
            // IE8 doesn't like this...
            removeListener(isIE ? msgTarget : window, 'message', onDie);
          } catch (ohWell) { }
          if (cb) doPost({ a: 'error', d: 'client closed window' });
          cb = undefined;
          // explicitly close the window, in case the client is trying to reload or nav
          try { window.close(); } catch (e) { }
        };
        addListener(window, 'unload', onUnload);
        return {
          detach: function() {
            removeListener(window, 'unload', onUnload);
          }
        };
      }
    };
  } else {
    return {
      open: function(url, winopts, arg, cb) {
        setTimeout(function() { cb("unsupported browser"); }, 0);
      },
      onOpen: function(cb) {
        setTimeout(function() { cb("unsupported browser"); }, 0);
      }
    };
  }
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WinChan;
}

},{}]},{},[1]);

/* ── wiki-security-hitchhiker-passport ─────────────────────────────────────────
   Everything ABOVE this line is upstream wiki-security-passportjs, unmodified.
   Everything BELOW is the appended hitchhiker bootstrap. To upgrade upstream:
   copy the new client/security.js over this file and re-append everything below
   this line.
   ────────────────────────────────────────────────────────────────────────────── */

/* Bootstrap the hitchhiker client layer on every page. This security client is
   loaded globally via wiki.security(user), so it is the farm-wide injection
   point. Each entry is a plugin's client script, served by that plugin; a plugin
   that is not installed simply 404s and the rest still load. Since hitchhiker
   0.5.0 the layer is three plugins, not one. */
;(function () {
  var bust = /localhost$/.test(location.hostname) ? '?v=' + Date.now() : ''
  var scripts = [
    ['wiki-ux-loader',          '/plugins/hitchhiker/wiki-ux.js'],          // page-flag tools, drop-to-preview, hearth guard
    ['wiki-chooser-loader',     '/plugins/chooser/wiki-chooser.js'],        // the factory chooser
    ['wiki-fish-picker-loader', '/plugins/fish-picker/wiki-fish-picker.js'],// site identity flag editor
    ['wiki-terms-loader',       '/plugins/terms/wiki-terms.js']             // terms fork interceptor
  ]
  for (var i = 0; i < scripts.length; i++) {
    try {
      if (document.getElementById(scripts[i][0])) continue
      var s = document.createElement('script')
      s.id = scripts[i][0]
      s.src = scripts[i][1] + bust
      s.defer = true
      ;(document.head || document.documentElement).appendChild(s)
    } catch (e) {
      if (window.console) console.error('[wiki-security-hitchhiker-passport] bootstrap failed for ' + scripts[i][1], e)
    }
  }
})();

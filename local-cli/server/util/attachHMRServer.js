/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */
'use strict';

const querystring = require('querystring');
const url = require('url');

/**
 * Attaches a WebSocket based connection to the Packager to expose
 * Hot Module Replacement updates to the simulator.
 */
function attachHMRServer({httpServer, path, packagerServer}) {
  
  let clients = [];
  
  let platformCache = {
    android: {
      dependenciesCache: [],
      dependenciesModulesCache: {},
      shallowDependencies: {},
      bundleEntry: '',
    },
    iOS: {
      dependenciesCache: [],
      dependenciesModulesCache: {},
      shallowDependencies: {},
      bundleEntry: '',
    },
  }

  function addClient (client) {
    
      // Only register callback if it's the first client
      if (clients.length === 0) {
        packagerServer.setHMRFileChangeListener(onHMRChange);
      }

      client.ws.on('error', e => {
        console.error('[Hot Module Replacement] Unexpected error', e);
        disconnect(client);
      });

      client.ws.on('close', () => disconnect(client));
  }

  function disconnect (disconnectedClient) {
    clients = clients.filter(client => client != disconnectedClient);
    //Only clear change listener if there are no more listening clients
    if (clients.length === 0) {
      packagerServer.setHMRFileChangeListener(null);
    }
  }

  function connectedPlatformClients () {
    return {
      android: clients.filter(client => client.platform === "android"), 
      iOS: clients.filter(client => client.platform === "iOS"),
    }
  }

  function forEachPlatform (callback) {
    const platformClients = connectedPlatformClients();
    return Promise.all([
      wrapPotentialPromise(platformClients.android.length > 0 ? callback("android", platformClients.android) : null),
      wrapPotentialPromise(platformClients.iOS.length > 0 ? callback("iOS", platformClients.iOS) : null),
    ]).then(results => ({
       android: results[0],
       iOS: results[1],
    }))
  }

  function sendToClients (message, platform) {
    if (platform) {
      clients.forEach(client => client.ws.send(JSON.stringify(message)));
    }
    else {
      connectedPlatformClients()[platform].map(client => client.ws.send(message))
    }
  }

  // Runs whenever a file changes
  function onHMRChange (filename, stat)  {
      if (clients.length === 0) {
        return;
      }

      sendToClients({type: 'update-start'});

      stat.then(() => {
        return packagerServer.getShallowDependencies(filename)
          .then(deps => {
            if (clients.length === 0) {
              return {};
            }

            return forEachPlatform(platform => {
              // if the file dependencies have change we need to invalidate the
              // dependencies caches because the list of files we need to send
              // to the client may have changed
              const oldDependencies = platformCache[platform].shallowDependencies[filename];
              if (arrayEquals(deps, oldDependencies)) {
                // Need to create a resolution response to pass to the bundler
                // to process requires after transform. By providing a
                // specific response we can compute a non recursive one which
                // is the least we need and improve performance.
                return packagerServer.getDependencies({
                  platform: platform,
                  dev: true,
                  entryFile: filename,
                  recursive: true,
                }).then(response => {
                  const module = packagerServer.getModuleForPath(filename);

                  return response.copy({dependencies: [module]});
                });
              }

              // if there're new dependencies compare the full list of
              // dependencies we used to have with the one we now have
              return getDependencies(platform, platformCache.bundleEntry)
                .then(({
                  dependenciesCache,
                  dependenciesModulesCache,
                  shallowDependencies,
                  resolutionResponse,
                }) => {

                  // build list of modules for which we'll send HMR updates
                  const modulesToUpdate = [packagerServer.getModuleForPath(filename)];
                  Object.keys(dependenciesModulesCache).forEach(module => {
                    if (!platformCache[platform].dependenciesModulesCache[module]) {
                      modulesToUpdate.push(dependenciesModulesCache[module]);
                    }
                  });

                  // invalidate caches
                  platformCache[platform].dependenciesCache = dependenciesCache;
                  platformCache[platform].dependenciesModulesCache = dependenciesModulesCache;
                  platformCache[platform].shallowDependencies = shallowDependencies;

                  return resolutionResponse.copy({
                    dependencies: modulesToUpdate
                  });
                });
              
            });
          })
          .then((resolutionResponse) => {
            if (clients.length === 0) {
              return {};
            }
            return forEachPlatform(platform => {
              
              if (!resolutionResponse[platform]) {
                return;
              }

              if (!platformCache[platform].shallowDependencies[filename]){
                return;
              }
              
              return packagerServer.buildBundleForHMR({
                entryFile: platformCache[platform].bundleEntry,
                platform: platform,
                resolutionResponse,
              });
            });
          })
          .then(bundles => {
            if (clients.length === 0) {
              return {};
            }

            return forEachPlatform(platform => {

              const bundle = bundles[platform];

              if (!bundle || bundle.isEmpty()) {
                return;
              }
              return {
                type: 'update',
                body: {
                  modules: bundle.getModulesCode(),
                  sourceURLs: bundle.getSourceURLs(),
                  sourceMappingURLs: bundle.getSourceMappingURLs(),
                },
              };
            });
          })
          .catch(error => {
            // send errors to the client instead of killing packager server
            let body;
            if (error.type === 'TransformError' ||
                error.type === 'NotFoundError' ||
                error.type === 'UnableToResolveError') {
              body = {
                type: error.type,
                description: error.description,
                filename: error.filename,
                lineNumber: error.lineNumber,
              };
            } else {
              console.error(error.stack || error);
              body = {
                type: 'InternalError',
                description: 'react-packager has encountered an internal error, ' +
                  'please check your terminal error output for more details',
              };
            }

            return forEachPlatform(platform => ({type: 'error', body}));
          })
          .then(update => {
            if (clients.length === 0) {
              return;
            }

            forEachPlatform(platform => {
              if (!update[platform]) {
                return;
              }
              sendToClients(update[platform], platform);
            });
          })
        },
        () => {
          // do nothing, file was removed
        }
      ).finally(() => {
        sendToClients({type: 'update-done'});
      });
    }

  // Returns a promise with the full list of dependencies and the shallow
  // dependencies each file on the dependency list has for the give platform
  // and entry file.
  function getDependencies(platform, bundleEntry) {
    return packagerServer.getDependencies({
      platform: platform,
      dev: true,
      entryFile: bundleEntry,
    }).then(response => {
      // for each dependency builds the object:
      // `{path: '/a/b/c.js', deps: ['modA', 'modB', ...]}`
      return Promise.all(Object.values(response.dependencies).map(dep => {
        return dep.getName().then(depName => {
          if (dep.isAsset() || dep.isAsset_DEPRECATED() || dep.isJSON()) {
            return Promise.resolve({path: dep.path, deps: []});
          }
          return packagerServer.getShallowDependencies(dep.path)
            .then(deps => {
              return {
                path: dep.path,
                name: depName,
                deps,
              };
            });
        });
      }))
      .then(deps => {
        // list with all the dependencies' filenames the bundle entry has
        const dependenciesCache = response.dependencies.map(dep => dep.path);

        // map from module name to path
        const moduleToFilenameCache = Object.create(null);
        deps.forEach(dep => moduleToFilenameCache[dep.name] = dep.path);

        // map that indicates the shallow dependency each file included on the
        // bundle has
        const shallowDependencies = Object.create(null);
        deps.forEach(dep => shallowDependencies[dep.path] = dep.deps);

        // map from module name to the modules' dependencies the bundle entry
        // has
        const dependenciesModulesCache = Object.create(null);
        return Promise.all(response.dependencies.map(dep => {
          return dep.getName().then(depName => {
            dependenciesModulesCache[depName] = dep;
          });
        })).then(() => {
          return {
            dependenciesCache,
            dependenciesModulesCache,
            shallowDependencies,
            resolutionResponse: response,
          };
        });
      });
    });
  }

  const WebSocketServer = require('ws').Server;
  const wss = new WebSocketServer({
    server: httpServer,
    path: path,
  });

  console.log('[Hot Module Replacement] Server listening on', path);
  wss.on('connection', ws => {
    console.log('[Hot Module Replacement] Client connected');
    const params = querystring.parse(url.parse(ws.upgradeReq.url).query);

    getDependencies(params.platform, params.bundleEntry)
      .then(({
        dependenciesCache,
        dependenciesModulesCache,
        shallowDependencies,
      }) => {

        const client = {
          ws,
          platform: params.platform,
        };

        //Set the platform dependency cache when a new client connects
        platformCache[params.platform] = {
          dependenciesCache,
          dependenciesModulesCache,
          shallowDependencies,
          bundleEntry: params.bundleEntry,
        };

        addClient(client);
      })
    .done();
  });
}

function arrayEquals(arrayA, arrayB) {
  arrayA = arrayA || [];
  arrayB = arrayB || [];
  return (
    arrayA.length === arrayB.length &&
    arrayA.every((element, index) => {
      return element === arrayB[index];
    })
  );
}

function wrapPotentialPromise (valueOrPromise) {
  if (valueOrPromise == null) {
    return Promise.resolve(valueOrPromise)
  }
  else if (valueOrPromise.then && typeof valueOrPromise === "function") {
    return valueOrPromise
  }
  else {
    return Promise.resolve(valueOrPromise)
  }
}

module.exports = attachHMRServer;

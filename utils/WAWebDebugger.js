if (!window.mR) {
    const moduleRaid = function () {
      moduleRaid.mID  = Math.random().toString(36).substring(7);
      moduleRaid.mObj = {};

      fillModuleArray = function() {
        (window.webpackChunkbuild || window.webpackChunkwhatsapp_web_client).push([
          [moduleRaid.mID], {}, function(e) {
            Object.keys(e.m).forEach(function(mod) {
              moduleRaid.mObj[mod] = e(mod);
            })
          }
        ]);
      }

      fillModuleArray();

      get = function get (id) {
        return moduleRaid.mObj[id]
      }

      findModule = function findModule (query) {
        results = [];
        modules = Object.keys(moduleRaid.mObj);

        modules.forEach(function(mKey) {
          mod = moduleRaid.mObj[mKey];

          if (typeof mod !== 'undefined') {
            if (typeof query === 'string') {
              if (typeof mod.default === 'object') {
                for (key in mod.default) {
                  if (key == query) results.push(mod);
                }
              }

              for (key in mod) {
                if (key == query) results.push(mod);
              }
            } else if (typeof query === 'function') { 
              if (query(mod)) {
                results.push(mod);
              }
            } else {
              throw new TypeError('findModule can only find via string and function, ' + (typeof query) + ' was passed');
            }

          }
        })

        return results;
      }

      return {
        modules: moduleRaid.mObj,
        constructors: moduleRaid.cArr,
        findModule: findModule,
        get: get
      }
    }

    window.mR = moduleRaid();   
}


if (!window.injected) {
    const decodeStanza = (window.mR.findModule('decodeStanza')[0]).decodeStanza;
    const encodeStanza = (window.mR.findModule('encodeStanza')[0]).encodeStanza;


    (window.mR.findModule('decodeStanza')[0]).decodeStanza = async (e, t) => {
        const result = await decodeStanza(e, t);

        console.log('FROM SERVER ->', result.toString());
        return result;
    }


    (window.mR.findModule('encodeStanza')[0]).encodeStanza = (e) => {
        const result = encodeStanza(e);

        console.log('TO SERVER ->', e.toString());
        return result;
    }

    window.injected = true;
}
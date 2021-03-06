/**
 * HTTP(s) connection to UnityBase server. Exports a {@link UBConnection} class
 *
 * @module @unitybase/base/UBConnection
 */

const http = require('http')
const _ = require('lodash')
const UBSession = require('./UBSession')
const CryptoJS = require('@unitybase/cryptojs/core')
const {ServerRepository} = require('./ServerRepository')
const UBDomain = require('./UBDomain')

CryptoJS.MD5 = require('@unitybase/cryptojs/md5')
// regular expression for URLs server not require authorization.
const NON_AUTH_URLS_RE = /(\/|^)(models|auth|getAppInfo|downloads)(\/|\?|$)/

/* global nsha256,btoa */
/**
 * Using instance of this class you can execute a authorized UnityBase server methods.
 *
 * The most used method is {@link UBConnection#query  UBConnection.query} - a authorized request to `ubql` endpoint.
 *

     var UBConnection = require('UBConnection');
     var conn = new UBConnection({host: 'localhost', port: '888', path: 'autotest', keepAlive: true});
     // alternative way is:
     // var conn = new UBConnection('http://localhost:888/orm');
     // but in this case keepAlive is false
     conn.onRequestAuthParams = function(){ return {authSchema: 'UB', login: 'admin', password: 'admin'} }
     var domain = conn.getDomainInfo();
     if (domain.has('my_entity')){
               ..
      }

 * @class
 * @param {Object} options Connection parameters. See {@link module:http http.request} for details
 */
function UBConnection (options) {
  let me = this
  let client = http.request(options)
  let /** @type UBDomain */
    _domain
  let ubSession = null
  let lookupCache = {}
  let userDataDefault = { lang: 'en' }
  let appInfo = {}

  /**
  * Internal instance of HTTP client
  * @type {ClientRequest}
  * @protected
  * @readonly
  */
  this.clientRequest = client
  let appName = client.options.path
  let servicePath = client.options.path
  if (servicePath.charAt(servicePath.length - 1) !== '/') servicePath = servicePath + '/' // normalize path
  if (appName.length !== 1) {
    if (appName.charAt(0) === '/') appName = appName.slice(1, 100) // remove leading / from app name
    if (appName.charAt(appName.length - 1) === '/') appName = appName.slice(0, appName.length - 1) // remove / from end of app name
  }

  /**
   * Root path to all application-level method
   * @type {String}
   * @readonly
   */
  this.servicePath = servicePath

  /**
   * Name of UnityBase application
   * @type {String}
   * @readonly
   */
  this.appName = appName
  /**
   * Callback for resolving user credential.
   * Take a {@link UBConnection} as a parameter, must return authorization parameters object:
   *
   *      {authSchema: authType, login: login, password: password, [apiKey: ]}
   *
   * For a internal usage (requests from a locahost or other systems, etc.) and in case `authShema == 'UB'` it is possible to pass a
   * `apiKey` instead of a password. apiKey is actually a `uba_user.uPasswordHashHexa` content
   *
   * @type {function}
   */
  this.onRequestAuthParams = null

  /**
   * @deprecated Do not use this property doe to memory overuse - see http://forum.ub.softline.kiev.ua/viewtopic.php?f=12&t=85
   * @private
   */
  appInfo = this.get('getAppInfo') // non-auth request

  /**
   * Return information about how application is configured as returned by `getAppInfo` endpoint
   * @return {Object}
   */
  this.getAppInfo = function () {
    return appInfo
  }

  /**
   * Retrieve application domain information.
   * @param {Boolean} [isExtended=false] For member of admin group cen return a addinitonal domain information, such as mappings, connection details, indexes
   * @return {UBDomain}
   */
  this.getDomainInfo = function (isExtended) {
    if (!_domain) {
      // authorize connection to get a valid user name
      if (this.authNeed) this.authorize(false)

      let domainData = this.get('getDomainInfo', {
        v: 4,
        userName: this.userLogin(),
        extended: isExtended || undefined
      })
      _domain = new UBDomain(domainData)
    }
    return _domain
  }

  /**
   * Endpoint name for query (`runList` before 1.12, `ubql` after 1.12)
   * @type {string}
   */
  this.queryMethod = appInfo.serverVersion.startsWith('1.9.') || appInfo.serverVersion.startsWith('1.10.') ? 'runList' : 'ubql'

  /** Is server require content encryption
   * @type {Boolean}
   * @readonly
   */
  this.encryptContent = appInfo.encryptContent || false

  /** `base64` encoded server certificate used for cryptographic operation
   * @type {Boolean}
   * @readonly
   */
  this.serverCertificate = appInfo.serverCertificate || ''

  /** Lifetime (in second) of session encryption
   * @type {Number}
   * @readonly
   */
  this.sessionKeyLifeTime = appInfo.sessionKeyLifeTime || 0

  /**
   * Possible server authentication method
   * @type {Array.<string>}
   * @readonly
   */
  this.authMethods = appInfo.authMethods

  /**
   * Is UnityBase server require authorization
   * @type {Boolean}
   * @readonly
   */
  this.authNeed = me.authMethods && (me.authMethods.length > 0)

  // noinspection JSUnusedGlobalSymbols
  /**
   * AdminUI settings
   * @type {Object}
   */
  this.appConfig = appInfo['adminUI']

  /**
   *
   * @param {Boolean} isRepeat
   * @private
   * @return {UBSession}
   */
  this.authorize = function (isRepeat) {
    let resp, serverNonce, secretWord, pwdHash
    if (!ubSession || isRepeat) {
      ubSession = null
      if (!this.onRequestAuthParams) {
        throw new Error('set UBConnection.onRequestAuthParams function to perform authorized requests')
      }
      let authParams = this.onRequestAuthParams(this)
      if (authParams.authSchema === 'UBIP') {
        if (isRepeat) {
          throw new Error('UBIP authentication must not return false on the prev.step')
        }
        resp = this.xhr({endpoint: 'auth', headers: {'Authorization': authParams.authSchema + ' ' + authParams.login}})
        ubSession = new UBSession(resp, '', authParams.authSchema)
      } else {
        resp = this.get('auth', {
          AUTHTYPE: authParams.authSchema || 'UB',
          userName: authParams.login
        })
        let clientNonce = nsha256(new Date().toISOString().substr(0, 16))
        let request2 = {
          clientNonce: clientNonce
        }
        if (resp.connectionID) {
          request2.connectionID = resp.connectionID
        }
        request2.AUTHTYPE = authParams.authSchema || 'UB'
        request2.userName = authParams.login
        if (resp['realm']) { // LDAP
          serverNonce = resp['nonce']
          if (!serverNonce) {
            throw new Error('invalid LDAP auth response')
          }
          if (resp['useSasl']) {
            pwdHash = CryptoJS.MD5(authParams.login.split('\\')[1].toUpperCase() + ':' + resp.realm + ':' + authParams.password)
            // we must calculate md5(login + ':' + realm + ':' + password) in binary format
            pwdHash.concat(CryptoJS.enc.Utf8.parse(':' + serverNonce + ':' + clientNonce))
            request2.password = CryptoJS.MD5(pwdHash).toString()
            secretWord = request2.password // todo - must be pwdHash but UB server do not know it :( medium unsecured
          } else {
            request2.password = btoa(authParams.password)
            secretWord = request2.password // todo -  very unsecured!!
          }
        } else {
          serverNonce = resp.result
          if (!serverNonce) {
            throw new Error('invalid auth response')
          }
          if (authParams.apiKey) {
            pwdHash = authParams.apiKey
          } else {
            pwdHash = nsha256('salt' + authParams.password)
          }
          request2.password = nsha256(appName.toLowerCase() + serverNonce + clientNonce + authParams.login + pwdHash).toString()
          secretWord = pwdHash
        }
        resp = this.get('auth', request2)
        ubSession = new UBSession(resp, secretWord, authParams.authSchema)
      }
    }
    return ubSession
  }

  /**
   * Check is current connection already perform authentication request
   * @returns {boolean}
   */
  this.isAuthorized = function () {
    return Boolean(ubSession)
  }

  /**
   * Return current user logon or 'anonymous' in case not logged in
   * @returns {String}
   */
  this.userLogin = function () {
    return this.isAuthorized() ? ubSession.logonname : 'anonymous'
  }

  /**
   * Return current user language or 'en' in case not logged in
   * @returns {String}
   */
  this.userLang = function () {
    return this.userData('lang')
  }

  /**
   * Return custom data for logged in user, or {lang: 'en'} in case not logged in
   *
   * If key is provided - return only key part of user data:
   *
   *      $App.connection.userData('lang');
   *      // or the same but dedicated alias
   *      $App.connection.userLang()
   *
   * @param {String} [key] Optional key
   * @returns {*}
   */
  this.userData = function (key) {
    let uData = this.isAuthorized() ? ubSession.userData : userDataDefault
    return key ? uData[key] : uData
  }

  /**
   * Lookup value in entity using aCondition.
   *
   *      // create condition using Repository
   *      var myID = conn.lookup('ubm_enum', 'ID',
   *           conn.Repository('ubm_enum').where('eGroup', '=', 'UBA_RULETYPE').where('code', '=', 'A').ubql().whereList
   *          );
   *      // or pass condition directly
   *      var adminID = conn.lookup('uba_user', 'ID', {
   *             expression: 'name', condition: 'equal', values: {nameVal: 'admin'}
   *          });
   *
   * @param {String} aEntity - entity to lookup
   * @param {String} lookupAttribute - attribute to lookup
   * @param {String|Object} aCondition - lookup condition. String in case of custom expression,
   *      or whereListItem {expression: condition: values: },
   *      or whereList {condition1: {expression: condition: values: }, condition2: {}, ....}
   * @param {Boolean} [doNotUseCache=false]
   * @return {*} `lookupAttribute` value of first result row or null if not found.
   */
  this.lookup = function (aEntity, lookupAttribute, aCondition, doNotUseCache) {
    let me = this
    let cKey = aEntity + JSON.stringify(aCondition) + lookupAttribute
    let request

    if (!doNotUseCache && lookupCache.hasOwnProperty(cKey)) {
      return lookupCache[cKey] // found in cache
    } else {
      request = this.Repository(aEntity).attrs(lookupAttribute).limit(1).ubql()

      if (typeof aCondition === 'string') {
        request.whereList = {lookup: {expression: aCondition, condition: 'custom'}}
      } else if (aCondition.expression && (typeof aCondition.expression === 'string')) {
        request.whereList = {lookup: aCondition}
      } else {
        request.whereList = aCondition
      }

      let resData = me.query(request).resultData.data
      if ((resData.length === 1) && (resData[0][0] != null)) { // `!= null` is equal to (not null && not undefined)
        if (!doNotUseCache) {
          lookupCache[cKey] = resData[0][0]
        }
        return resData[0][0]
      } else {
        return null
      }
    }
  }
}

/**
 * Perform authorized UBQL request.
 * Can take one QB Query or an array of UB Query and execute it at once.
 * @param {Object|Array<Object>} ubq
 * @returns {Object|Array}
 */
UBConnection.prototype.query = function (ubq) {
  if (Array.isArray(ubq)) {
    return this.xhr({endpoint: this.queryMethod, data: ubq})
  } else {
    return this.xhr({endpoint: this.queryMethod, data: [ubq]})[0]
  }
}

/**
 * HTTP request to UB server. In case of success response return body parsed to {Object} or {ArrayBuffer} depending of Content-Type response header
 *
 * @example
 *  conn.xhr({
 *      endpoint: 'runSQL',
 *      URLParams: {CONNECTION: 'dba'},
 *      data: 'DROP SCHEMA IF EXISTS ub_autotest CASCADE; DROP USER IF EXISTS ub_autotest;'
 *  });
 *
 * @param {Object} options
 * @param {String} options.endpoint
 * @param {String} [options.UBMethod] This parameter is **DEPRECATED**. Use `options.endpoint` instead
 * @param {String} [options.HTTPMethod='POST']
 * @param {Object} [options.headers] Optional request headers in format {headerName: headerValue, ..}
 * @param {Boolean} [options.simpleTextResult=false] do not parse response and return it as is even if response content type is JSON
 * @param {*} [options.URLParams] Optional parameters added to URL using http.buildURL
 * @param {ArrayBuffer|Object|String} [options.data] Optional body
 * @param  {String} [options.responseType] see <a href="https://developer.mozilla.org/en-US/docs/DOM/XMLHttpRequest#responseType">responseType</a>.
 *                                          Currently only `arraybuffer` suported.
 * @returns {ArrayBuffer|Object|String|Array<Object>}
 */
UBConnection.prototype.xhr = function (options) {
  let me = this
  let req = this.clientRequest
  let resp
  let result = {}

  let path = this.servicePath + (options.endpoint || options.UBMethod)
  if (options.URLParams) {
    path = http.buildURL(path, options.URLParams)
  }
  if (me.authNeed && !NON_AUTH_URLS_RE.test(path)) { // request need authentication
    let session = me.authorize(me._inRelogin)
    req.setHeader('Authorization', session.authHeader())
  }
  req.setMethod(options.HTTPMethod || 'POST') // must be after auth request!
  req.setPath(path)

  if (options.headers) {
    _.forEach(options.headers, function (val, key) {
      req.setHeader(key, val)
    })
  }
  if (options.data) {
    if (options.data.toString() === '[object ArrayBuffer]') {
      req.setHeader('Content-Type', 'application/octet-stream')
    } else {
      req.setHeader('Content-Type', 'application/json;charset=utf-8')
    }
    resp = req.end(options.data)
  } else {
    resp = req.end()
  }
  let status = resp.statusCode

  if (status >= 200 && status < 300) {
    if (options.responseType === 'arraybuffer') {
      result = resp.read('bin')
    } else if (((resp.headers['content-type'] || '').indexOf('json') >= 0) && !options.simpleTextResult) {
      result = JSON.parse(resp.read())
    } else {
      result = resp.read() // return string readed as UTF-8
    }
  } else if (status === 401 && me.isAuthorized()) { // relogin
    if (me._inRelogin) {
      me._inRelogin = false
      throw new Error('invalid user name or password')
    }
    me._inRelogin = true
    console.debug('Session expire - repeat auth request')
    try {
      result = me.xhr(options)
    } finally {
      me._inRelogin = false
    }
  } else {
    if ((status === 500) && ((resp.headers['content-type'] || '').indexOf('json') >= 0)) { // server report error and body is JSON
      let respObj = JSON.parse(resp.read())
      if (respObj.errMsg) {
        throw new Error('Server error: "' + respObj.errMsg)
      } else {
        throw new Error('HTTP communication error: "' + status + ': ' + http.STATUS_CODES[status] + '" during request to: ' + path)
      }
    } else {
      throw new Error('HTTP communication error: "' + status + ': ' + http.STATUS_CODES[status] + '" during request to: ' + path)
    }
  }
  return result
}

/**
 * Perform get request to `endpoint` with optional URLParams.
 * @param {String} endpoint
 * @param {*} [URLParams]
 * @returns {ArrayBuffer|Object|String}
 */
UBConnection.prototype.get = function (endpoint, URLParams) {
  let params = {
    endpoint: endpoint,
    HTTPMethod: 'GET'
  }
  if (URLParams) { params.URLParams = URLParams }
  return this.xhr(params)
}

/**
 * Shortcut method to perform authorized `POST` request to application we connected
 * @param {String} endpoint
 * @param {ArrayBuffer|Object|String} data
 * @returns {ArrayBuffer|Object|String|Array<object>}
 */
UBConnection.prototype.post = function (endpoint, data) {
  return this.xhr({endpoint: endpoint, data: data})
}

/**
 * Shortcut method to perform authorized `POST` request to `ubql` endpoint
 * @private
 * @deprecated Since UB 1.11 use UBConnection.query
 * @param {Array.<ubRequest>} runListData
 * @returns {Object}
 */
UBConnection.prototype.runList = function (runListData) {
  return this.xhr({endpoint: this.queryMethod, data: runListData})
}

/**
 * Send request to any endpoint. For entity-level method execution (`ubql` endpoint) better to use {@link UBConnection#query UBConnection.query}
 * @returns {*} body of HTTP request result. If !simpleTextResult and response type is json - then parsed to object
 */
UBConnection.prototype.runCustom = function (endpoint, aBody, aURLParams, simpleTextResult, aHTTPMethod) {
  return this.xhr({HTTPMethod: aHTTPMethod || 'POST', endpoint: endpoint, URLParams: aURLParams, data: aBody, simpleTextResult: simpleTextResult})
  // throw new Error ('Use one of runList/run/post/xhr UBConnection methods');
}

/**
 * Shortcut method to perform authorized `POST` request to `ubql` endpoint.
 * Can take one ubRequest and wrap it to array
 * @deprecated Since UB 1.11 use UBConnection.query
 * @param {ubRequest} request
 * @returns {Object}
 */
UBConnection.prototype.run = function (request) {
  return this.xhr({endpoint: this.queryMethod, data: [request]})[0]
}

/**
 * Logout from server if logged in
 */
UBConnection.prototype.logout = function () {
  if (this.isAuthorized()) {
    try {
      this.post('logout', '')
    } catch (e) {
    }
  }
}

/**
 * Set document method saves a file content as a potential value of the specified entity instance attribute,
 * the value is saved to temp store.
 * Call this function before entity insert of update. Result of this function is what shall be assigned to the
 * attribute value, to "execParams".
 * @param {string} entity Entity name
 * @param {string} attribute Entity attribute name
 * @param {number} id ID of the record
 * @param {ArrayBuffer} data File content
 * @param {string} origName
 * @param {string} [fileName] If not specified, origName will be used.
 * @return {string}
 *
 * @example
    const myObj = conn.Repository(entityName)
      .attrs('ID', 'mi_modifyDate')
      .where('code', '=', code)
      .selectSingle()
    const {ID, mi_modifyDate} = myObj
    const data = fs.readFileSync(fileName, {encoding: 'bin'})
    const tempStoreResult = conn.setDocument(entityName, 'configuration', ID, data, fn)
    conn.query({
      entity: entityName,
      method: 'update',
      execParams: {ID, configuration: tempStoreResult, mi_modifyDate}
    })
 */
UBConnection.prototype.setDocument = function (entity, attribute, id, data, origName, fileName) {
  const setDocumentResponse = this.xhr({
    HTTPMethod: 'POST',
    endpoint: 'setDocument',
    data,
    URLParams: {
      entity,
      attribute,
      id,
      origName: origName || fileName,
      filename: fileName || origName
    }
  })
  return JSON.stringify(setDocumentResponse.result)
}

/**
 * Execute insert method by add method: 'insert' to `ubq` query (if req.method not already set)
 *
 * If `ubq.fieldList` contain only `ID` return inserted ID, else return array of attribute values passed to `fieldList`.
 * If no field list passed at all - return response.resultData (null usually).
 *
        var testRole = conn.insert({
            entity: 'uba_role',
            fieldList: ['ID', 'mi_modifyDate'],
            execParams: {
                name: 'testRole1',
                allowedAppMethods: 'runList'
            }
        });
        console.log(testRole); //[3000000000200,"2014-10-21T11:56:37Z"]

        var testRoleID = conn.insert({
            entity: 'uba_role',
            fieldList: ['ID'],
            execParams: {
                name: 'testRole1',
                allowedAppMethods: 'runList'
            }
        });
        console.log(testRoleID); //3000000000200
 *
 * @param {ubRequest} ubq
 * @return {*}
 */
UBConnection.prototype.insert = function (ubq) {
  // var req = _.clone(ubq, true)
  let req = ubq
  req.method = req.method || 'insert'
  let res = this.query(req)
  if (req.fieldList) {
    return (req.fieldList.length === 1) && (req.fieldList[0] = 'ID') ? res.resultData.data[0][0] : res.resultData.data[0]
  } else {
    return res.resultData
  }
}

/**
 * Create a new instance of repository
 * @param {String} entityName name of Entity we create for
 * @returns {ServerRepository}
 */
UBConnection.prototype.Repository = function (entityName) {
  return new ServerRepository(this, entityName)
}

module.exports = UBConnection

# ldapauth-fork

[![Sponsored by Wakeone](https://img.shields.io/badge/sponsored%20by-wakeone-389fc1.svg)](https://wakeone.co)

Fork of [node-ldapauth](https://github.com/trentm/node-ldapauth) - A simple node.js lib to authenticate against an LDAP server.

## About the fork

This fork was originally created and published because of an urgent need to get newer version of [ldapjs](http://ldapjs.org/) in use to [passport-ldapauth](https://github.com/vesse/passport-ldapauth) since the newer version supported passing `tlsOptions` to the TLS module. Since then a lot of issues from the original module ([#2](https://github.com/trentm/node-ldapauth/issues/2), [#3](https://github.com/trentm/node-ldapauth/issues/3), [#8](https://github.com/trentm/node-ldapauth/issues/8), [#10](https://github.com/trentm/node-ldapauth/issues/10), [#11](https://github.com/trentm/node-ldapauth/issues/11), [#12](https://github.com/trentm/node-ldapauth/issues/12), [#13](https://github.com/trentm/node-ldapauth/pull/13)) have been fixed, and new features have been added as well.

Multiple [ldapjs](http://ldapjs.org/) client options have been made available.

## Usage

```javascript
var LdapAuth = require('ldapauth-fork');
var options = {
  url: 'ldaps://ldap.example.org:636',
  ...
};
var auth = new LdapAuth(options);
auth.on('error', function (err) {
  console.error('LdapAuth: ', err);
});
...
auth.authenticate(username, password, function(err, user) { ... });
...
auth.close(function(err) { ... })
```

`LdapAuth` inherits from `EventEmitter`.

## Install

    npm install ldapauth-fork

## `LdapAuth` Config Options

Required ldapjs client options:

- `url` - LDAP server URL, eg. _ldaps://ldap.example.org:636_, or a list of URLs, e.g. `["ldaps://ldap.example.org:636"]`

ldapauth-fork options:

- `bindDN` - Admin connection DN, e.g. _uid=myapp,ou=users,dc=example,dc=org_. Optional. If not given at all, admin client is not bound. Giving empty string may result in anonymous bind when allowed.
- `bindCredentials` - Password for bindDN.
- `searchBase` - The base DN from which to search for users by username. E.g. _ou=users,dc=example,dc=org_
- `searchFilter` - LDAP search filter with which to find a user by username, e.g. _(uid={{username}})_. Use the literal _{{username}}_ to have the given username interpolated in for the LDAP search.
- `searchAttributes` - Optional, default all. Array of attributes to fetch from LDAP server.
- `bindProperty` - Optional, default _dn_. Property of the LDAP user object to use when binding to verify the password. E.g. _name_, _email_
- `searchScope` - Optional, default _sub_. Scope of the search, one of _base_, _one_, or _sub_.

ldapauth-fork can look for valid users groups too. Related options:

- `groupSearchBase` - Optional. The base DN from which to search for groups. If defined, also `groupSearchFilter` must be defined for the search to work.
- `groupSearchFilter` - Optional. LDAP search filter for groups. Place literal _{{dn}}_ in the filter to have it replaced by the property defined with `groupDnProperty` of the found user object. _{{username}}_ is also available and will be replaced with the _uid_ of the found user. This is useful for example to filter PosixGroups by _memberUid_. Optionally you can also assign a function instead. The found user is passed to the function and it should return a valid search filter for the group search.
- `groupSearchAttributes` - Optional, default all. Array of attributes to fetch from LDAP server.
- `groupDnProperty` - Optional, default _dn_. The property of user object to use in _{{dn}}_ interpolation of `groupSearchFilter`.
- `groupSearchScope` - Optional, default _sub_.

Other ldapauth-fork options:

- `includeRaw` - Optional, default false. Set to true to add property `_raw` containing the original buffers to the returned user object. Useful when you need to handle binary attributes
- `cache` - Optional, default false. If true, then up to 100 credentials at a time will be cached for 5 minutes.
- `log` - Bunyan logger instance, optional. If given this will result in TRACE-level error logging for component:ldapauth. The logger is also passed forward to ldapjs.

Optional ldapjs options, see [ldapjs documentation](https://github.com/mcavage/node-ldapjs/blob/v1.0.1/docs/client.md):

- `tlsOptions` - Needed for TLS connection. See [Node.js documentation](https://nodejs.org/api/tls.html#tls_tls_connect_options_callback)
- `socketPath`
- `timeout`
- `connectTimeout`
- `idleTimeout`
- `reconnect`
- `strictDN`
- `queueSize`
- `queueTimeout`
- `queueDisable`

## How it works

The LDAP authentication flow is usually:

1. Bind the admin client using the given `bindDN` and `bindCredentials`
2. Use the admin client to search for the user by substituting `{{username}}` from the `searchFilter` with given username
3. If user is found, verify the given password by trying to bind the user client with the found LDAP user object and given password
4. If password was correct and group search options were provided, search for the groups of the user

## express/connect basicAuth example

```javascript
var basicAuth = require('basic-auth');
var LdapAuth = require('ldapauth-fork');

var ldap = new LdapAuth({
  url: 'ldaps://ldap.example.org:636',
  bindDN: 'uid=myadminusername,ou=users,dc=example,dc=org',
  bindCredentials: 'mypassword',
  searchBase: 'ou=users,dc=example,dc=org',
  searchFilter: '(uid={{username}})',
  reconnect: true,
});

var rejectBasicAuth = function (res) {
  res.statusCode = 401;
  res.setHeader('WWW-Authenticate', 'Basic realm="Example"');
  res.end('Access denied');
};

var basicAuthMiddleware = function (req, res, next) {
  var credentials = basicAuth(req);
  if (!credentials) {
    return rejectBasicAuth(res);
  }

  ldap.authenticate(credentials.name, credentials.pass, function (err, user) {
    if (err) {
      return rejectBasicAuth(res);
    }

    req.user = user;
    next();
  });
};
```

## License

MIT

`ldapauth-fork` has been partially sponsored by [Wakeone Ltd](https://wakeone.co/).

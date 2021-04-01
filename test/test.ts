/**
 * A dummy manual test script
 */
 import * as Logger from 'bunyan';
 import * as LdapAuth from '../lib/ldapauth';
 
 const log = new Logger({
     name: 'ldap',
     component: 'client',
     stream: process.stderr,
     level: 'trace'
 });
 
 const opts: LdapAuth.Options = {
   url: 'ldap://ldap.forumsys.com:389',
   bindDN: 'cn=read-only-admin,dc=example,dc=com',
   bindCredentials: 'password',
   searchBase: 'dc=example,dc=com',
   searchFilter: '(uid={{username}})',
   log: log,
   cache: true,
   includeRaw: true,
   groupSearchFilter: '(member={{dn}})',
   groupSearchBase: 'dc=example,dc=com'
 };
 
 const optsWithoutAdmin: LdapAuth.Options = {
     url: 'ldap://ldap.forumsys.com:389',
     bindDN: 'uid={{username}},dc=example,dc=com',
     bindCredentials: '{{password}}',
     searchBase: 'dc=example,dc=com',
     searchFilter: '(uid={{username}})',
     log: log,
     cache: true,
     includeRaw: true,
     groupSearchFilter: '(member={{dn}})',
     groupSearchBase: 'dc=example,dc=com'
   };
 
 const auth = new LdapAuth(opts);
 
 auth.on('error', (err) => {
     console.warn(err);
     // TODO: auth.close() doesn't do anything here
 });
 
 auth.authenticate('riemann', 'password', (err, user) => {
     if (err) {
         console.warn(err);
         auth.close(() => console.log('Unbound'));
     } else {
         console.log(user);
         // Re-auth to be able to verify cache works
         auth.authenticate('riemann', 'password', (err, user) => {
             if (err) {
                 console.warn(err);
             } else {
                 console.log('Re-auth user DN:', user.dn);
             }
             auth.close();
         });
     }
 });
 
 const authWithoutAdmin = new LdapAuth(optsWithoutAdmin);
 
 authWithoutAdmin.on('error', (err) => {
     console.warn(err);
     // TODO: auth.close() doesn't do anything here
 });
 
 authWithoutAdmin.authenticate('riemann', 'password', (err, user) => {
     if (err) {
         console.warn(err);
         authWithoutAdmin.close(() => console.log('Unbound'));
     } else {
         console.log(user);
         // Re-auth to be able to verify cache works
         authWithoutAdmin.authenticate('riemann', 'password', (err, user) => {
             if (err) {
                 console.warn(err);
             } else {
                 console.log('Re-auth user DN:', user.dn);
             }
             authWithoutAdmin.close();
         });
     }
 });
 
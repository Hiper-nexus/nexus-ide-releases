import test from 'node:test';import assert from 'node:assert/strict';
import { selectEntitlement } from '../src/licences.js';
import type { SubscriptionRow } from '../src/db/schema.js';
const now=1_000_000;
const sub=(values:Partial<SubscriptionRow>):SubscriptionRow=>({id:'s',owner_type:'account',account_id:'a',team_id:null,stripe_subscription_id:'sub',stripe_customer_id:'cus',plan:'pro',status:'active',seats:1,current_period_end:now+3600000,grace_until:null,billing_interval:null,created_at:now,updated_at:now,...values});
test('cancelled subscription cannot grant a paid license',()=>assert.equal(selectEntitlement([sub({status:'canceled'})],now).plan,'free'));
test('license lifetime never extends beyond the paid period or grace',()=>{assert.equal(selectEntitlement([sub({})],now).ttl,3600);assert.equal(selectEntitlement([sub({status:'past_due',grace_until:now+60000})],now).ttl,60);});
test('expired or unproven period does not grant paid features',()=>{for(const current_period_end of [null,now-1])assert.equal(selectEntitlement([sub({current_period_end})],now).plan,'free');});

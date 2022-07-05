import type { PermissionsRequestSchema } from '../../src/interfaces/permissions/types';

import { expect } from 'chai';
import { secp256k1 } from '../../src/jose/algorithms/signing/secp256k1';
import { Message } from '../../src/core/message';
import { PermissionsRequest } from '../../src/interfaces/permissions/messages/permissions-request';


describe('Message', () => {
  describe('parse', () => {
    it('throws an exception if raw message is missing descriptor', () => {
      expect(() => {
        Message.parse({});
      }).throws('descriptor');
    });

    it('throws an exception if descriptor is not an object', () => {
      expect(() => {
        const tests = [[], 'descriptor', 1, true, null];

        for (const t of tests) {
          expect(() => {
            const m = { descriptor: t };
            Message.parse(m);
          }).to.throw('array');
        }
      }).to.throw('object');
    });

    it('throws an exception if raw message descriptor is missing method', () => {
      expect(() => {
        const m = { descriptor: {} };
        Message.parse(m);
      }).throws('descriptor');
    });

    it('throws an exception if schema doesnt exist for message type', () => {
      expect(() => {
        const m = { descriptor: { method: 'KakaRequest' } };
        Message.parse(m);
      }).throws('not found.');
    });

    it('throws an exception if validation fails', () => {
      expect(() => {
        const m = {
          descriptor: { method: 'PermissionsRequest' }
        };
        Message.parse(m);
      }).throws('required property');
    });

    it('returns parseled message if validation succeeds', async () => {
      const { privateJwk } = await secp256k1.generateKeyPair();
      const signatureInput = {
        jwkPrivate      : privateJwk,
        protectedHeader : {
          alg : privateJwk.alg as string,
          kid : 'did:jank:bob'
        }
      };

      const creator = await PermissionsRequest.create({
        description : 'drugs',
        grantedBy   : 'did:jank:bob',
        grantedTo   : 'did:jank:alice',
        scope       : { method: 'CollectionsWrite' },
        signatureInput
      });

      const jsonMessage = Message.parse(creator.toObject());

      expect(jsonMessage).to.not.be.undefined;
      expect((jsonMessage as PermissionsRequestSchema).authorization).to.not.be.undefined;
    });
  });
});
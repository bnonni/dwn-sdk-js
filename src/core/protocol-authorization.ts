import type { MessageStore } from '../store/message-store.js';
import type { RecordsWrite } from '../interfaces/records/messages/records-write.js';
import type { RecordsWriteMessage } from '../interfaces/records/types.js';
import type { BaseMessage, Filter } from './types.js';
import type { ProtocolDefinition, ProtocolRuleSet, ProtocolsConfigureMessage } from '../interfaces/protocols/types.js';

import { DwnInterfaceName, DwnMethodName, Message } from './message.js';

const methodToAllowedActionMap: Record<string, string> = {
  [DwnMethodName.Write]: 'write',
  [DwnMethodName.Query]: 'query',
};

/**
 * looks setup for only authorizing write events, and performs various functions on RecordsWrite events. I assume I would need to create all the corresponding RecordsRead types? In addition, 
 */

export class ProtocolAuthorization {

  /**
   * Performs protocol-based authorization against the given message.
   * @throws {Error} if authorization fails.
   */
  public static async authorize(
    tenant: string,
    recordsWrite: RecordsWrite,
    requesterDid: string,
    messageStore: MessageStore
  ): Promise<void> {
    // fetch the protocol definition
    const protocolDefinition = await ProtocolAuthorization.fetchProtocolDefinition(tenant, recordsWrite, messageStore);

    // fetch ancestor message chain
    const ancestorMessageChain: RecordsWriteMessage[] = await ProtocolAuthorization.constructAncestorMessageChain(tenant, recordsWrite, messageStore);

    // record schema -> schema label map
    const recordSchemaToLabelMap: Map<string, string> = new Map();
    for (const schemaLabel in protocolDefinition.labels) {
      const schema = protocolDefinition.labels[schemaLabel].schema;
      recordSchemaToLabelMap.set(schema, schemaLabel);
    }

    // get the rule set for the inbound message
    const inboundMessageRuleSet = ProtocolAuthorization.getRuleSet(
      recordsWrite.message,
      protocolDefinition,
      ancestorMessageChain,
      recordSchemaToLabelMap
    );

    // verify method invoked against the allowed actions
    ProtocolAuthorization.verifyAllowedActions(
      tenant,
      requesterDid,
      recordsWrite,
      inboundMessageRuleSet,
      ancestorMessageChain,
      recordSchemaToLabelMap
    );

    // verify allowed condition of the write
    await ProtocolAuthorization.verifyActionCondition(tenant, recordsWrite, messageStore);
  }

  /**
   * Fetches the protocol definition based on the protocol specified in the given message.
   */
  private static async fetchProtocolDefinition(tenant: string, recordsWrite: RecordsWrite, messageStore: MessageStore): Promise<ProtocolDefinition> {
    // get the protocol URI
    const protocolUri = recordsWrite.message.descriptor.protocol!;

    // fetch the corresponding protocol definition
    const query: Filter = {
      interface : DwnInterfaceName.Protocols,
      method    : DwnMethodName.Configure,
      protocol  : protocolUri
    };
    const protocols = await messageStore.query(tenant, query) as ProtocolsConfigureMessage[];

    if (protocols.length === 0) {
      throw new Error(`unable to find protocol definition for ${protocolUri}`);
    }

    const protocolMessage = protocols[0];
    return protocolMessage.descriptor.definition;
  }

  /**
   * Constructs a chain of ancestor messages
   * @returns the ancestor chain of messages where the first element is the root of the chain; returns empty array if no parent is specified.
   */
  private static async constructAncestorMessageChain(tenant: string, recordsWrite: RecordsWrite, messageStore: MessageStore)
    : Promise<RecordsWriteMessage[]> {
    const ancestorMessageChain: RecordsWriteMessage[] = [];

    const protocol = recordsWrite.message.descriptor.protocol!;
    const contextId = recordsWrite.message.contextId!;

    // keep walking up the chain from the inbound message's parent, until there is no more parent
    let currentParentId = recordsWrite.message.descriptor.parentId;
    while (currentParentId !== undefined) {
      // fetch parent
      const query: Filter = {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        protocol,
        contextId,
        recordId  : currentParentId
      };
      const parentMessages = await messageStore.query(tenant, query) as RecordsWriteMessage[];

      if (parentMessages.length === 0) {
        throw new Error(`no parent found with ID ${currentParentId}`);
      }

      const parent = parentMessages[0];
      ancestorMessageChain.push(parent);

      currentParentId = parent.descriptor.parentId;
    }

    return ancestorMessageChain.reverse(); // root ancestor first
  }

  /**
   * Gets the rule set corresponding to the inbound message.
   */
  private static getRuleSet(
    inboundMessage: RecordsWriteMessage,
    protocolDefinition: ProtocolDefinition,
    ancestorMessageChain: RecordsWriteMessage[],
    recordSchemaToLabelMap: Map<string, string>
  ): ProtocolRuleSet {
    // make a copy of the ancestor messages and include the inbound message in the chain
    const messageChain = [...ancestorMessageChain, inboundMessage];

    // walk down the ancestor message chain from the root ancestor record and match against the corresponding rule set at each level
    // to make sure the chain structure is allowed
    let allowedRecordsAtCurrentLevel: { [key: string]: ProtocolRuleSet} | undefined = protocolDefinition.records;
    let currentMessageIndex = 0;
    while (true) {
      const currentRecordSchema = messageChain[currentMessageIndex].descriptor.schema;
      const currentRecordType = recordSchemaToLabelMap.get(currentRecordSchema!);

      if (currentRecordType === undefined) {
        throw new Error(`record with schema '${currentRecordSchema}' not allowed in protocol`);
      }

      if (allowedRecordsAtCurrentLevel === undefined || !(currentRecordType in allowedRecordsAtCurrentLevel)) {
        throw new Error(`record with schema: '${currentRecordSchema}' not allowed in structure level ${currentMessageIndex}`);
      }

      // if we are looking at the inbound message itself (the last message in the chain),
      // then we have found the access control object we need to evaluate against
      if (currentMessageIndex === messageChain.length - 1) {
        return allowedRecordsAtCurrentLevel[currentRecordType];
      }

      // else we keep going down the message chain
      allowedRecordsAtCurrentLevel = allowedRecordsAtCurrentLevel[currentRecordType].records;
      currentMessageIndex++;
    }
  }

  /**
   * Verifies the actions specified in the given message matches the allowed actions in the rule set.
   * @throws {Error} if action not allowed.
   */
  private static verifyAllowedActions(
    tenant: string,
    requesterDid: string,
    incomingMessage: Message<BaseMessage>,
    inboundMessageRuleSet: ProtocolRuleSet,
    ancestorMessageChain: RecordsWriteMessage[],
    recordSchemaToLabelMap: Map<string, string>
  ): void {
    const allowRule = inboundMessageRuleSet.allow;
    const incomingMessageMethod = incomingMessage.message.descriptor.method;

    if (allowRule === undefined) {
      // if no allow rule is defined, owner of DWN can do everything
      if (requesterDid === tenant) {
        return;
      } else {
        throw new Error(`no allow rule defined for ${incomingMessageMethod}, ${requesterDid} is unauthorized`);
      }
    }

    const allowedActions = new Set<string>();
    if (allowRule.anyone !== undefined) {
      allowRule.anyone.to.forEach(action => allowedActions.add(action));
    }

    if (allowRule.author !== undefined) {
      const messageForAuthorCheck = ProtocolAuthorization.getMessage(
        ancestorMessageChain,
        allowRule.author.of,
        recordSchemaToLabelMap
      );
      const expectedRequesterDid = Message.getAuthor(messageForAuthorCheck);

      if (requesterDid === expectedRequesterDid) {
        allowRule.author.to.forEach(action => allowedActions.add(action));
      }
    }

    if (allowRule.recipient !== undefined) {
      const messageForRecipientCheck = ProtocolAuthorization.getMessage(
        ancestorMessageChain,
        allowRule.recipient.of,
        recordSchemaToLabelMap
      );
      const expectedRequesterDid = messageForRecipientCheck.descriptor.recipient;

      if (requesterDid === expectedRequesterDid) {
        allowRule.recipient.to.forEach(action => allowedActions.add(action));
      }
    }

    const inboundMessageAction = methodToAllowedActionMap[incomingMessageMethod];
    if (!allowedActions.has(inboundMessageAction)) {
      throw new Error(`inbound message action '${inboundMessageAction}' not in list of allowed actions (${new Array(...allowedActions).join(',')})`);
    }
  }

  /**
   * Verifies if the desired action can be taken.
   * Currently the only check is: if the write is not the initial write, the author must be the same as the initial write
   * @throws {Error} if fails verification
   */
  private static async verifyActionCondition(tenant: string, recordsWrite: RecordsWrite, messageStore: MessageStore): Promise<void> {
    const isInitialWrite = await recordsWrite.isInitialWrite();
    if (!isInitialWrite) {
      // fetch the initialWrite
      const query = {
        entryId: recordsWrite.message.recordId
      };
      const result = await messageStore.query(tenant, query) as RecordsWriteMessage[];

      // check the author of the initial write matches the author of the incoming message
      const initialWrite = result[0];
      const authorOfInitialWrite = Message.getAuthor(initialWrite);
      if (recordsWrite.author !== authorOfInitialWrite) {
        throw new Error(`author of incoming message '${recordsWrite.author}' must match to author of initial write '${authorOfInitialWrite}'`);
      }
    }
  }

  /**
   * Gets the message from the message chain based on the path specified.
   * @param messagePath `/` delimited path starting from the root ancestor.
   *                    Each path segment denotes the expected record type declared in protocol definition.
   *                    e.g. `A/B/C` means that the root ancestor must be of type A, its child must be of type B, followed by a child of type C.
   *                    NOTE: the path scheme use here may be temporary dependent on final protocol spec.
   */
  private static getMessage(
    ancestorMessageChain: RecordsWriteMessage[],
    messagePath: string,
    recordSchemaToLabelMap: Map<string, string>
  ): RecordsWriteMessage {
    const expectedAncestors = messagePath.split('/');

    // consider moving this check to ProtocolsConfigure message ingestion
    if (expectedAncestors.length > ancestorMessageChain.length) {
      throw new Error('specified path to expected recipient is longer than actual length of ancestor message chain');
    }

    let i = 0;
    while (true) {
      const expectedAncestorType = expectedAncestors[i];
      const ancestorMessage = ancestorMessageChain[i];

      const actualAncestorType = recordSchemaToLabelMap.get(ancestorMessage.descriptor.schema!);
      if (actualAncestorType !== expectedAncestorType) {
        throw new Error(`mismatching record schema: expecting ${expectedAncestorType} but actual ${actualAncestorType}`);
      }

      // we have found the message if we are looking at the last message specified by the path
      if (i + 1 === expectedAncestors.length) {
        return ancestorMessage;
      }

      i++;
    }
  }

}
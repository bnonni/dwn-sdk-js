import type { BaseMessage } from '../../core/types.js';
import type { DwnInterfaceName, DwnMethodName } from '../../core/message.js';

/**
 * Descriptor structure for HooksWrite
 */
export type HooksWriteDescriptor = {
  interface: DwnInterfaceName.Hooks;
  method: DwnMethodName.Write;
  dateCreated: string;

  /**
   * Leave as `undefined` for customer handler.
   * ie. DWN processing will use `undefined` check to attempt to invoke the registered handler.
   */
  uri?: string;

  /**
   * Intentionally all required properties for first iteration.
   */
  filter: {
    method: string;
  }
};

/**
 * Structure for HooksWrite message.
 */
export type HooksWriteMessage = BaseMessage & {
  descriptor: HooksWriteDescriptor;
};
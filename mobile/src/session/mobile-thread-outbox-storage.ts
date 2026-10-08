// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: thread-outbox-storage sobre AsyncStorage (uma chave por mensagem sob prefixo, no lugar de um arquivo por mensagem no expo-file-system, sem flush de escritas em voo: o enqueue já espera a escrita), erros como Error simples em vez de TaggedError do Effect.
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  type MobileQueuedThreadMessage,
  type MobileThreadOutboxStorage
} from './mobile-thread-outbox'

const THREAD_OUTBOX_KEY_PREFIX = 'nexus:thread-outbox:v1:'

export class ThreadOutboxStorageError extends Error {
  constructor(
    readonly operation: 'load' | 'read-message' | 'write' | 'remove',
    readonly key: string | null,
    readonly reason: unknown
  ) {
    super(`Thread outbox storage operation ${operation} failed for key ${key ?? 'unknown'}.`)
    this.name = 'ThreadOutboxStorageError'
  }
}

function messageKey(messageId: string): string {
  return `${THREAD_OUTBOX_KEY_PREFIX}${encodeURIComponent(messageId)}`
}

export const asyncStorageThreadOutboxStorage: MobileThreadOutboxStorage = {
  load: async () => {
    const messages: MobileQueuedThreadMessage[] = []
    const errors: ThreadOutboxStorageError[] = []
    let entries: readonly (readonly [string, string | null])[]
    try {
      const keys = (await AsyncStorage.getAllKeys()).filter((key) =>
        key.startsWith(THREAD_OUTBOX_KEY_PREFIX)
      )
      entries = keys.length > 0 ? await AsyncStorage.multiGet(keys) : []
    } catch (cause) {
      throw new ThreadOutboxStorageError('load', null, cause)
    }
    for (const [key, raw] of entries) {
      if (raw === null) {
        continue
      }
      try {
        messages.push(decodeQueuedThreadMessage(JSON.parse(raw) as unknown))
      } catch (cause) {
        // Recover readable messages; an unreadable one is reported, not dropped.
        errors.push(new ThreadOutboxStorageError('read-message', key, cause))
      }
    }
    return { messages, errors }
  },
  write: async (message) => {
    const key = messageKey(message.messageId)
    try {
      await AsyncStorage.setItem(key, encodeQueuedThreadMessage(message))
    } catch (cause) {
      throw new ThreadOutboxStorageError('write', key, cause)
    }
  },
  remove: async (message) => {
    const key = messageKey(message.messageId)
    try {
      await AsyncStorage.removeItem(key)
    } catch (cause) {
      throw new ThreadOutboxStorageError('remove', key, cause)
    }
  }
}

import {
  chatConversation,
  chatMembership,
  chatMessage,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('Work Chat database schema', () => {
  it('stores one retained Work Conversation per Quest', () => {
    const columns = getTableColumns(chatConversation);

    expect(columns.questId.name).toBe('quest_id');
    expect(columns.type.name).toBe('type');
    expect(columns.questTitle.name).toBe('quest_title');
    expect(columns.questStatus.name).toBe('quest_status');
    expect(getTableConfig(chatConversation).uniqueConstraints).toHaveLength(1);
    expect(getTableConfig(chatConversation).foreignKeys).toHaveLength(1);
  });

  it('stores Assignment-scoped inclusive Chat Membership windows', () => {
    const columns = getTableColumns(chatMembership);
    const config = getTableConfig(chatMembership);

    expect(columns.assignmentId.name).toBe('assignment_id');
    expect(columns.joinedAt.name).toBe('joined_at');
    expect(columns.leftAt.name).toBe('left_at');
    expect(config.foreignKeys).toHaveLength(3);
    expect(config.indexes).toHaveLength(4);
  });

  it('keeps System Message event identity and transition command identity durable', () => {
    const messageColumns = getTableColumns(chatMessage);
    const commandColumns = getTableColumns(chatTransitionCommand);

    expect(messageColumns.eventId.name).toBe('event_id');
    expect(messageColumns.systemPayload.name).toBe('system_payload');
    expect(commandColumns.producer.name).toBe('producer');
    expect(commandColumns.commandId.name).toBe('command_id');
    expect(commandColumns.requestIdentity.name).toBe('request_identity');
    expect(getTableConfig(chatMessage).uniqueConstraints).toHaveLength(1);
    expect(getTableConfig(chatTransitionCommand).uniqueConstraints).toHaveLength(1);
  });
});

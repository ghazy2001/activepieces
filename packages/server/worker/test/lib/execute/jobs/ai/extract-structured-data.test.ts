import { AIProviderName } from '@activepieces/core-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let lastGenerateArgs: any = null
let mockToolCalls: any[] = [{ input: { user_name: 'John Doe', age: 30 } }]

vi.mock('@activepieces/server-utils', () => ({
    aiUtils: {
        createModel: (args: Record<string, unknown>) => ({ modelId: args['modelId'] }),
    },
}))

vi.mock('ai', () => ({
    generateText: async (args: any) => {
        lastGenerateArgs = args
        return {
            text: 'ok',
            toolCalls: mockToolCalls,
        }
    },
    jsonSchema: (schema: any) => schema,
    tool: (t: any) => t,
}))

const { extractStructuredData } = await import('../../../../../src/lib/execute/jobs/ai/extract-structured-data')

const FLOW_STEP = {
    projectId: 'project-1',
    platformId: 'platform-1',
    flowId: 'flow-1',
    runId: 'run-1',
}

const RESOLVED = {
    provider: AIProviderName.ANTHROPIC,
    providerConfigId: 'config-1',
    auth: { apiKey: 'key' },
    config: {},
}

describe('extractStructuredData', () => {
    beforeEach(() => {
        lastGenerateArgs = null
        mockToolCalls = [{ input: { user_name: 'John Doe', age: 30 } }]
    })

    it('sends toolChoice: required and normal guide for models supporting forced tool choice', async () => {
        await extractStructuredData({
            data: {
                prompt: 'Extract user info',
                text: 'My name is John Doe and I am 30 years old.',
                schema: {
                    mode: 'simple',
                    fields: [
                        { name: 'user_name', type: 'string', isRequired: true },
                        { name: 'age', type: 'number', isRequired: false },
                    ],
                },
            } as any,
            resolved: RESOLVED as any,
            modelId: 'claude-haiku-5-5',
            flowStep: FLOW_STEP as any,
            billing: null as any,
            files: [],
        })

        expect(lastGenerateArgs).not.toBeNull()
        expect(lastGenerateArgs.toolChoice).toBe('required')
        const messageText = lastGenerateArgs.messages[0].content[0].text
        expect(messageText).not.toContain('You must call the extractData tool with the extracted data.')
    })

    it.each([
        'claude-opus-5-5',
        'claude-opus-5.5',
        'claude-sonnet-5-5',
        'claude-sonnet-5.5',
        'claude-fable-5-1',
        'claude-mythos-5-1',
        'anthropic/claude-opus-5.5',
        'us.anthropic.claude-sonnet-5-5-20250929-v1:0',
    ])('sends toolChoice: auto and instruction to call extractData for model %s', async (modelId) => {
        await extractStructuredData({
            data: {
                prompt: 'Extract user info',
                text: 'My name is John Doe and I am 30 years old.',
                schema: {
                    mode: 'simple',
                    fields: [
                        { name: 'user_name', type: 'string', isRequired: true },
                    ],
                },
            } as any,
            resolved: RESOLVED as any,
            modelId,
            flowStep: FLOW_STEP as any,
            billing: null as any,
            files: [],
        })

        expect(lastGenerateArgs).not.toBeNull()
        expect(lastGenerateArgs.toolChoice).toBe('auto')
        const messageText = lastGenerateArgs.messages[0].content[0].text
        expect(messageText).toContain('You must call the extractData tool with the extracted data.')
    })

    it('throws when no tool calls are returned by the model', async () => {
        mockToolCalls = []

        await expect(extractStructuredData({
            data: {
                prompt: 'Extract user info',
                text: 'Hello world',
                schema: {
                    mode: 'simple',
                    fields: [{ name: 'user_name', type: 'string', isRequired: true }],
                },
            } as any,
            resolved: RESOLVED as any,
            modelId: 'claude-opus-5-5',
            flowStep: FLOW_STEP as any,
            billing: null as any,
            files: [],
        })).rejects.toThrow('No structured data could be extracted from the input.')
    })

    it('restores sanitized field names in extracted result', async () => {
        mockToolCalls = [{ input: { user_field_name: 'test-value' } }]

        const result = await extractStructuredData({
            data: {
                prompt: 'Extract',
                text: 'test',
                schema: {
                    mode: 'simple',
                    fields: [{ name: 'user field name', type: 'string', isRequired: true }],
                },
            } as any,
            resolved: RESOLVED as any,
            modelId: 'claude-sonnet-5-5',
            flowStep: FLOW_STEP as any,
            billing: null as any,
            files: [],
        })

        expect(result).toEqual({ 'user field name': 'test-value' })
    })
})

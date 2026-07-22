import test from 'node:test';
import assert from 'node:assert/strict';
import { isAlibabaOpenAIBaseURL, parseAlibabaCredentialCsv } from './alibabaCredentialCsv.js';

test('imports the API key and workspace-specific OpenAI endpoint from Alibaba CSV', () => {
  const parsed = parseAlibabaCredentialCsv(`id,workspace-123
apiKey,sk-example-not-a-real-secret
apiHost,ws-example.us-east-1.maas.aliyuncs.com
openAiCompatible,https://ws-example.us-east-1.maas.aliyuncs.com/compatible-mode/v1
dashScope,https://ws-example.us-east-1.maas.aliyuncs.com/api/v1`);
  assert.equal(parsed.apiKey, 'sk-example-not-a-real-secret');
  assert.equal(parsed.baseURL, 'https://ws-example.us-east-1.maas.aliyuncs.com/compatible-mode/v1');
});

test('accepts official Alibaba OpenAI-compatible endpoint families', () => {
  assert.equal(isAlibabaOpenAIBaseURL('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isAlibabaOpenAIBaseURL('https://dashscope-us.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isAlibabaOpenAIBaseURL('https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isAlibabaOpenAIBaseURL('https://coding-intl.dashscope.aliyuncs.com/v1'), true);
});

test('rejects a CSV that could send the key outside Alibaba', () => {
  assert.throws(() => parseAlibabaCredentialCsv(`id,workspace-123
apiKey,sk-example-not-a-real-secret
openAiCompatible,https://example.com/compatible-mode/v1`), /oficial do workspace/);
  assert.equal(isAlibabaOpenAIBaseURL('http://workspace.us-east-1.maas.aliyuncs.com/compatible-mode/v1'), false);
  assert.equal(isAlibabaOpenAIBaseURL('https://workspace.us-east-1.maas.aliyuncs.com/compatible-mode/v1?key=secret'), false);
});

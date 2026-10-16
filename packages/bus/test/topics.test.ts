import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicMatches, topics } from '../src/index.ts';

test('topic wildcards', () => {
  assert.ok(topicMatches('ranch/events/+/+', topics.events('cam', 'gate_open')));
  assert.ok(topicMatches('ranch/#', 'ranch/frames/cam'));
  assert.ok(!topicMatches('ranch/frames/+', 'ranch/frames/cam/extra'));
  assert.ok(!topicMatches('ranch/frames/cam', 'ranch/frames/other'));
});

import { expect, test } from 'vitest';
import { escapeXml } from '../src/util/escapeXml';

test('escapeXml escapes characters', () => {
  expect(escapeXml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
});

test('escapeXml escapes additional characters', () => {
  expect(escapeXml('`=/')).toBe('&#x60;&#x3D;&#x2F;');
});

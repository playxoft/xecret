import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_VALUE_TYPE,
  SECRET_VALUE_TYPES,
  SECRET_VALUE_TYPE_DESCRIPTORS,
  checkSecretValue,
  isSecretValueType,
  toSecretValueType,
} from './value-type';
import type { SecretValueType } from './value-type';
import { checkXmlWellFormed } from './xml';

/** `expect(...).toBe(true)` with the rejection reason in the failure output. */
function accepts(value: string, type: SecretValueType): void {
  const result = checkSecretValue(value, type);
  expect(result.message ?? 'accepted').toBe('accepted');
  expect(result.valid).toBe(true);
}

function rejects(value: string, type: SecretValueType): void {
  const result = checkSecretValue(value, type);
  expect(result.valid).toBe(false);
  expect(result.message).toBeTypeOf('string');
}

describe('the type registry', () => {
  it('describes every type it declares', () => {
    for (const type of SECRET_VALUE_TYPES) {
      const descriptor = SECRET_VALUE_TYPE_DESCRIPTORS[type];
      expect(descriptor.type).toBe(type);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.hint.length).toBeGreaterThan(0);
    }
  });

  it('offers examples that pass their own check', () => {
    // A placeholder that would be rejected if typed teaches the wrong format.
    for (const descriptor of Object.values(SECRET_VALUE_TYPE_DESCRIPTORS)) {
      if (descriptor.example === '') continue;
      accepts(descriptor.example, descriptor.type);
    }
  });

  it('recognises its own members and nothing else', () => {
    for (const type of SECRET_VALUE_TYPES) expect(isSecretValueType(type)).toBe(true);
    for (const other of ['', 'STRING', 'uuid', 'number', null, 7, {}]) {
      expect(isSecretValueType(other)).toBe(false);
    }
  });

  it('falls back to string rather than throwing on an unknown type', () => {
    // A row written by a newer deployment must still render on an older one.
    expect(toSecretValueType('bigint')).toBe('string');
    expect(toSecretValueType(undefined)).toBe('string');
    expect(toSecretValueType('uuidv7')).toBe('uuidv7');
    expect(DEFAULT_SECRET_VALUE_TYPE).toBe('string');
  });

  it('accepts an empty value for every type', () => {
    // Emptiness is the write path's rule, not a shape failure. Reporting it here
    // would flag a row the moment its type is chosen, before anything is typed.
    for (const type of SECRET_VALUE_TYPES) accepts('', type);
  });
});

describe('string', () => {
  it('accepts anything at all', () => {
    for (const value of ['', 'hunter2', '{"a":', '<<<', '\u0000\uffff', ' ']) {
      accepts(value, 'string');
    }
  });
});

describe('boolean', () => {
  it('accepts the documented literals in any case', () => {
    for (const value of ['true', 'FALSE', 'True', '1', '0', 'yes', 'NO', 'on', 'Off']) {
      accepts(value, 'boolean');
    }
  });

  it('rejects anything else', () => {
    for (const value of ['t', 'f', 'y', 'n', '2', 'true false', 'enabled', '']) {
      if (value === '') continue;
      rejects(value, 'boolean');
    }
  });
});

describe('int', () => {
  it('accepts signed whole numbers', () => {
    for (const value of ['0', '5432', '-1', '+42', '007']) accepts(value, 'int');
  });

  it('accepts an identifier too large for a JavaScript number', () => {
    // 19 digits: `Number` would round this, which is why the check uses BigInt.
    accepts('9007199254740993', 'int');
    accepts('9223372036854775807', 'int');
    accepts('-9223372036854775808', 'int');
  });

  it('rejects values outside the 64-bit range', () => {
    rejects('9223372036854775808', 'int');
    rejects('-9223372036854775809', 'int');
  });

  it('rejects non-integers', () => {
    for (const value of ['1.5', '1e3', '0x10', '1_000', 'twelve', '--1', '1-']) {
      rejects(value, 'int');
    }
  });
});

describe('decimal', () => {
  it('accepts fixed-point numbers', () => {
    for (const value of ['0', '19.99', '-0.5', '+3.25', '.5', '100']) accepts(value, 'decimal');
  });

  it('rejects exponent notation, as documented', () => {
    rejects('1e3', 'decimal');
    rejects('1.5E-2', 'decimal');
  });

  it('rejects malformed numbers', () => {
    for (const value of ['1.', '1.2.3', '1,5', '', ' ']) {
      if (value === '') continue;
      rejects(value, 'decimal');
    }
  });
});

describe('email', () => {
  it('accepts ordinary addresses', () => {
    for (const value of [
      'ops@example.com',
      'first.last+tag@sub.example.co.uk',
      'a@b.io',
      "o'brien@example.com",
    ]) {
      accepts(value, 'email');
    }
  });

  it('rejects the mistakes people actually make', () => {
    for (const value of [
      'example.com',
      'ops@',
      '@example.com',
      'ops@localhost',
      'ops@example.com, dev@example.com',
      'Ops <ops@example.com>',
      'ops @example.com',
      'ops@@example.com',
      'ops@example..com',
      'ops@-example.com',
    ]) {
      rejects(value, 'email');
    }
  });

  it('rejects an address longer than the RFC maximum', () => {
    rejects(`${'a'.repeat(250)}@example.com`, 'email');
  });
});

describe('url', () => {
  it('accepts any absolute URL, whatever the scheme', () => {
    for (const value of [
      'https://api.example.com',
      'http://localhost:3030/path?q=1#frag',
      'postgres://user:pw@db.example:5432/app',
      'redis://cache.internal:6379/0',
      'amqps://mq.example.com',
      's3://bucket/key',
    ]) {
      accepts(value, 'url');
    }
  });

  it('rejects a relative or half-typed URL', () => {
    for (const value of ['example.com', '/path/only', 'https:', 'https://', '://example.com']) {
      rejects(value, 'url');
    }
  });

  it('rejects whitespace rather than letting URL strip it', () => {
    // `new URL` silently removes tabs and newlines, so these would otherwise be
    // stored as-is and parse differently in whatever consumes them.
    rejects('https://example.com/a b', 'url');
    rejects('https://exam\tple.com', 'url');
    rejects('https://example.com\n', 'url');
  });
});

describe('surrounding whitespace', () => {
  it('is rejected for every type that has a shape', () => {
    // The value is stored verbatim, so a validator that trimmed would approve a
    // value that never reaches the consumer in the form it approved.
    for (const [value, type] of [
      [' 5432 ', 'int'],
      ['true\n', 'boolean'],
      ['\tops@example.com', 'email'],
      ['2026-01-31 ', 'date'],
      [' 9b2f4c1e-8a3d-4f6b-9c2e-1d5a7b3e6f80', 'uuidv4'],
    ] as const) {
      rejects(value, type);
    }
  });

  it('says so specifically, instead of claiming the wrong shape', () => {
    // "Expected a whole number" is baffling when the value plainly is one and
    // the real problem is a newline the user cannot see.
    const result = checkSecretValue('5432\n', 'int');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('whitespace');
  });

  it('still reports the real problem when trimming would not help', () => {
    const result = checkSecretValue(' not a number ', 'int');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('whole number');
  });

  it('does not apply to string, which accepts whitespace as content', () => {
    accepts('  padded  ', 'string');
  });
});

describe('date', () => {
  it('accepts real calendar dates', () => {
    for (const value of ['2026-01-31', '2000-02-29', '1970-01-01']) accepts(value, 'date');
  });

  it('rejects dates that do not exist', () => {
    for (const value of ['2026-02-30', '2100-02-29', '2026-13-01', '2026-00-10', '2026-01-32']) {
      rejects(value, 'date');
    }
  });

  it('rejects other formats', () => {
    for (const value of ['31-01-2026', '2026/01/31', '2026-1-1', '2026-01-31T00:00:00Z']) {
      rejects(value, 'date');
    }
  });
});

describe('datetime', () => {
  it('accepts ISO 8601 with an offset or Z', () => {
    for (const value of [
      '2026-01-31T09:30:00Z',
      '2026-01-31T09:30Z',
      '2026-01-31T09:30:00.123456Z',
      '2026-01-31T09:30:00+05:30',
      '2026-01-31T09:30:00-08:00',
      '2026-01-31 09:30:00Z',
    ]) {
      accepts(value, 'datetime');
    }
  });

  it('rejects a timestamp with no timezone', () => {
    // The ambiguity is the bug: the writer means their zone, the reader assumes
    // UTC, and the difference shows up as an off-by-hours expiry.
    rejects('2026-01-31T09:30:00', 'datetime');
    rejects('2026-01-31 09:30', 'datetime');
  });

  it('rejects impossible times', () => {
    rejects('2026-01-31T24:00:00Z', 'datetime');
    rejects('2026-01-31T23:60:00Z', 'datetime');
    rejects('2026-06-30T23:59:60Z', 'datetime');
    rejects('2026-02-30T09:30:00Z', 'datetime');
  });
});

describe('json', () => {
  it('accepts any valid document, including a top-level scalar', () => {
    for (const value of ['{"region":"eu-west-1"}', '[1,2,3]', '"text"', '42', 'null', 'true']) {
      accepts(value, 'json');
    }
  });

  it('rejects malformed JSON without echoing it', () => {
    const result = checkSecretValue('{"key":"sk_live_51H8xR2abcdef"', 'json');
    expect(result.valid).toBe(false);
    // The native parser message quotes the offending token, which here is part
    // of a credential. Nothing from the value may reach the message.
    expect(result.message).toBe('That is not valid JSON.');
    expect(result.message).not.toContain('sk_live');
  });
});

describe('yaml', () => {
  it('accepts documents and plain scalars', () => {
    for (const value of [
      'region: eu-west-1',
      'a:\n  b: 1\n  c: [1, 2]',
      'just a string',
      '- 1\n- 2',
    ]) {
      accepts(value, 'yaml');
    }
  });

  it('rejects a broken block', () => {
    rejects('a:\n  - 1\n - 2\n', 'yaml');
    rejects('{unclosed: ', 'yaml');
  });

  it('reports a fixed message rather than the parser detail', () => {
    const result = checkSecretValue('{token: sk_live_51H8xR2', 'yaml');
    expect(result.valid).toBe(false);
    expect(result.message).toBe('That is not valid YAML.');
  });
});

describe('xml', () => {
  it('accepts well-formed documents', () => {
    for (const value of [
      '<config><region>eu-west-1</region></config>',
      '<?xml version="1.0" encoding="UTF-8"?><root/>',
      '<root attr="a > b" other=\'x\'/>',
      '<!-- leading comment --><root>text</root>',
      '<root><![CDATA[<not a tag>]]></root>',
      '<!DOCTYPE note SYSTEM "note.dtd"><note/>',
      '<ns:root xmlns:ns="urn:x"><ns:child/></ns:root>',
      '<root>\n  <a/>\n  <b>1</b>\n</root>\n',
    ]) {
      accepts(value, 'xml');
    }
  });

  it('rejects the ways XML is usually broken', () => {
    for (const value of [
      '<root>',
      '<root></toor>',
      '<root></root></root>',
      '<a><b></a></b>',
      '<root attr=unquoted/>',
      '<root a="1" a="2"/>',
      '<1root/>',
      '<!-- never closed',
      '<root><![CDATA[unterminated</root>',
      'text before <root/>',
      '<root/> text after',
      '<root',
    ]) {
      rejects(value, 'xml');
    }
  });

  it('reports the line the mismatch was found on', () => {
    const problem = checkXmlWellFormed('<root>\n  <a>\n  <b/>\n</root>');
    // Line 4 is where `</root>` appears while `</a>` was still owed, which is
    // what the message names — the report and the line agree.
    expect(problem?.message).toBe('Expected </a> but found </root>.');
    expect(problem?.line).toBe(4);
  });

  it('reports the opening line for a tag that is simply never closed', () => {
    // Nothing contradicts it later, so the only useful position is where the
    // unclosed element was opened.
    const problem = checkXmlWellFormed('<root>\n  <a>\n    <b/>\n');
    expect(problem?.message).toBe('<a> is never closed.');
    expect(problem?.line).toBe(2);
  });

  it('does not treat a > inside an attribute value as the end of the tag', () => {
    accepts('<root url="https://example.com/?a=1&amp;b=2" cmp="a > b"/>', 'xml');
  });
});

describe('ulid', () => {
  it('accepts canonical and lowercase forms', () => {
    accepts('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'ulid');
    accepts('01arz3ndektsv4rrffq69g5fav', 'ulid');
  });

  it('rejects the wrong length, the wrong alphabet, and an overflowing timestamp', () => {
    rejects('01ARZ3NDEKTSV4RRFFQ69G5FA', 'ulid');
    rejects('01ARZ3NDEKTSV4RRFFQ69G5FAVV', 'ulid');
    // I, L, O and U are excluded from Crockford base32 precisely because they
    // are misread as 1, 1, 0 and V.
    rejects('01ARZ3NDEKTSV4RRFFQ69G5FAI', 'ulid');
    rejects('81ARZ3NDEKTSV4RRFFQ69G5FAV', 'ulid');
    rejects('9b2f4c1e-8a3d-4f6b-9c2e-1d5a7b3e6f80', 'ulid');
  });
});

describe('uuid', () => {
  it('accepts the matching version and rejects the other', () => {
    const v4 = '9b2f4c1e-8a3d-4f6b-9c2e-1d5a7b3e6f80';
    const v7 = '019456f0-8c3a-7d21-9f4e-6b8a2c5d1e30';

    accepts(v4, 'uuidv4');
    accepts(v7, 'uuidv7');
    // The whole reason both types exist: a v7 id in a v4 field is the mistake
    // worth catching, and a version-agnostic check would pass it.
    rejects(v7, 'uuidv4');
    rejects(v4, 'uuidv7');
  });

  it('accepts uppercase', () => {
    accepts('9B2F4C1E-8A3D-4F6B-9C2E-1D5A7B3E6F80', 'uuidv4');
  });

  it('rejects a wrong variant nibble, braces, and an unhyphenated form', () => {
    rejects('9b2f4c1e-8a3d-4f6b-1c2e-1d5a7b3e6f80', 'uuidv4');
    rejects('{9b2f4c1e-8a3d-4f6b-9c2e-1d5a7b3e6f80}', 'uuidv4');
    rejects('9b2f4c1e8a3d4f6b9c2e1d5a7b3e6f80', 'uuidv4');
    rejects('00000000-0000-0000-0000-000000000000', 'uuidv4');
  });
});

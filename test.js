const test = require('brittle')
const HTTPParser = require('.')

const {
  constants: { REQUEST, RESPONSE, DATA, END }
} = HTTPParser

test('request', (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Type: application/x-www-form-urlencoded\r
Content-Length: 49\r
\r
name=FirstName+LastName&email=bsmth%40example.com`

  t.alike(
    [...parser.push(input)],
    [
      {
        type: REQUEST,
        version: 'HTTP/1.1',
        method: 'POST',
        url: '/users',
        headers: {
          host: 'example.com',
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': '49'
        }
      },
      {
        type: DATA,
        data: Buffer.from('name=FirstName+LastName&email=bsmth%40example.com')
      },
      {
        type: END
      }
    ]
  )
})

test('request, http/1.0 missing host', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
\r
`

  t.alike(
    [...parser.push(input)],
    [
      {
        type: REQUEST,
        version: 'HTTP/1.0',
        method: 'GET',
        url: '/users',
        headers: {}
      },
      {
        type: END
      }
    ]
  )
})

test('request, http/1.1 missing host', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('response', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 201 Created\r
Host: example.com\r
Content-Type: application/json\r
Content-Length: 154\r
Location: http://example.com/users/123\r
\r
{
  "message": "New user created",
  "user": {
    "id": 123,
    "firstName": "Example",
    "lastName": "Person",
    "email": "bsmth@example.com"
  }
}`

  t.alike(
    [...parser.push(input)],
    [
      {
        type: RESPONSE,
        version: 'HTTP/1.1',
        code: 201,
        reason: 'Created',
        headers: {
          host: 'example.com',
          'content-type': 'application/json',
          'content-length': '154',
          location: 'http://example.com/users/123'
        }
      },
      {
        type: DATA,
        data: Buffer.from(`{
  "message": "New user created",
  "user": {
    "id": 123,
    "firstName": "Example",
    "lastName": "Person",
    "email": "bsmth@example.com"
  }
}`)
      },
      {
        type: END
      }
    ]
  )
})

test('chunked response', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 201 Created\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
${(11).toString(16)}\r
First chunk\r
${(12).toString(16)}\r
Second chunk\r
0\r
\r\n`

  t.alike(
    [...parser.push(input)],
    [
      {
        type: RESPONSE,
        version: 'HTTP/1.1',
        code: 201,
        reason: 'Created',
        headers: {
          host: 'example.com',
          'transfer-encoding': 'chunked'
        }
      },
      {
        type: DATA,
        data: Buffer.from('First chunk')
      },
      {
        type: DATA,
        data: Buffer.from('Second chunk')
      },
      {
        type: END
      }
    ]
  )
})

test('chunked response, multiple', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 201 Created\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
${(11).toString(16)}\r
First chunk\r
${(12).toString(16)}\r
Second chunk\r
0\r
\r\n`

  t.alike(
    [...parser.push(input), ...parser.push(input)],
    [
      {
        type: RESPONSE,
        version: 'HTTP/1.1',
        code: 201,
        reason: 'Created',
        headers: {
          host: 'example.com',
          'transfer-encoding': 'chunked'
        }
      },
      {
        type: DATA,
        data: Buffer.from('First chunk')
      },
      {
        type: DATA,
        data: Buffer.from('Second chunk')
      },
      {
        type: END
      },
      {
        type: RESPONSE,
        version: 'HTTP/1.1',
        code: 201,
        reason: 'Created',
        headers: {
          host: 'example.com',
          'transfer-encoding': 'chunked'
        }
      },
      {
        type: DATA,
        data: Buffer.from('First chunk')
      },
      {
        type: DATA,
        data: Buffer.from('Second chunk')
      },
      {
        type: END
      }
    ]
  )
})

test('request, conflicting content-length and transfer-encoding', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 10\r
Transfer-Encoding: chunked\r
\r
5\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, transfer-encoding chunked case insensitive', (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: Chunked\r
\r
5\r
hello\r
0\r
\r\n`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('request, header exceeds max size', async (t) => {
  const parser = new HTTPParser({ maxHeaderSize: 64 })

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
X-Large: ${'A'.repeat(100)}\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, too many headers', async (t) => {
  const parser = new HTTPParser({ maxHeadersCount: 3 })

  const headers = Array.from({ length: 5 }, (_, i) => `X-Header-${i}: value\r`).join('\n')

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
${headers}
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, duplicate content-length', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 5\r
Content-Length: 10\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, duplicate transfer-encoding', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
Transfer-Encoding: chunked\r
\r
5\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, invalid header name', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
Invalid Header: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, null byte in header name', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /users HTTP/1.1\r\nHost: example.com\r\nX-Bad'),
    Buffer.from([0x00]),
    Buffer.from(': value\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, header without space after colon', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host:example.com\r
Content-Length: 0\r
\r
`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers.host, 'example.com')
})

test('request, content-length with trailing garbage', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 5abc\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID_CONTENT_LENGTH/)
})

test('request, chunk length with trailing garbage', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
5xyz\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, terminator split across pushes', (t) => {
  const head = 'GET / HTTP/1.0\r\nX-Foo: bar\r\n'
  const terminator = '\r\n'

  for (let i = 1; i < terminator.length; i++) {
    const parser = new HTTPParser()

    const result = [
      ...parser.push(Buffer.from(head + terminator.slice(0, i))),
      ...parser.push(Buffer.from(terminator.slice(i)))
    ]

    t.is(result[0].type, REQUEST)
    t.is(result[0].headers['x-foo'], 'bar')
  }
})

test('request, partial terminator match resets across pushes', (t) => {
  const parser = new HTTPParser()

  const result = [
    ...parser.push(Buffer.from('GET / HTTP/1.0\r\n')),
    ...parser.push(Buffer.from('X-Foo: bar\r\n')),
    ...parser.push(Buffer.from('\r\n'))
  ]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers['x-foo'], 'bar')
})

test('request, header size exceeded across multiple pushes', async (t) => {
  const parser = new HTTPParser({ maxHeaderSize: 64 })

  const result = []

  for (const msg of parser.push(Buffer.from('GET / HTTP/1.0\r\n'))) {
    result.push(msg)
  }

  for (const msg of parser.push(Buffer.from('X-A: value\r\n'))) {
    result.push(msg)
  }

  await t.exception(() => {
    for (const msg of parser.push(Buffer.from('X-Pad: ' + 'A'.repeat(30) + '\r\n\r\n'))) {
      result.push(msg)
    }
  }, /INVALID/)
})

test('request, chunk length with leading whitespace', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
 5\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, chunk length with trailing whitespace', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
5 \r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('response, non-numeric status code', async (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 abc OK\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, status code out of range', async (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 99999 OK\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, missing url and version', async (t) => {
  const parser = new HTTPParser()

  const input = `GET\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, missing version', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /path\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, null byte in header value', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /users HTTP/1.1\r\nHost: example.com\r\nX-Bad: val'),
    Buffer.from([0x00]),
    Buffer.from('ue\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, control character in header value', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /users HTTP/1.1\r\nHost: example.com\r\nX-Bad: val'),
    Buffer.from([0x01]),
    Buffer.from('ue\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, byte by byte', (t) => {
  const parser = new HTTPParser()

  const input = Buffer.from(
    'POST /users HTTP/1.1\r\nHost: example.com\r\nContent-Length: 5\r\n\r\nhello'
  )

  const result = []

  for (let i = 0; i < input.byteLength; i++) {
    for (const msg of parser.push(input.subarray(i, i + 1))) {
      result.push(msg)
    }
  }

  t.is(result[0].type, REQUEST)
  t.is(result[0].method, 'POST')
  t.is(result[result.length - 1].type, END)

  const body = Buffer.concat(result.filter((m) => m.type === DATA).map((m) => m.data))
  t.alike(body, Buffer.from('hello'))
})

test('end, returns remaining after upgrade', (t) => {
  const parser = new HTTPParser()

  const input =
    'GET /chat HTTP/1.1\r\n' +
    'Host: example.com\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    '\r\n' +
    'websocket-frame-data-here'

  const it = parser.push(input)

  const header = it.next()
  t.is(header.value.type, REQUEST)
  t.is(header.value.headers.upgrade, 'websocket')

  const end = it.next()
  t.is(end.value.type, END)

  const remaining = parser.end()
  t.alike(remaining, Buffer.from('websocket-frame-data-here'))
})

test('end, returns body when generator abandoned after header', (t) => {
  const parser = new HTTPParser()

  const input =
    'POST /upload HTTP/1.1\r\n' +
    'Host: example.com\r\n' +
    'Content-Length: 11\r\n' +
    '\r\n' +
    'hello world'

  const it = parser.push(input)

  const header = it.next()
  t.is(header.value.type, REQUEST)

  const remaining = parser.end()
  t.alike(remaining, Buffer.from('hello world'))
})

test('request, chunk size exceeds safe integer', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
fffffffffffffffff\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, chunk size exceeds max length', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked\r
\r
${'a'.repeat(17)}\r
hello\r
0\r
\r\n`

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, content-length exceeds safe integer', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Content-Length: 9007199254740993\r
\r
hello`

  await t.exception(() => [...parser.push(input)], /INVALID_CONTENT_LENGTH/)
})

test('request, chunk data missing CRLF terminator', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from(
      'POST /users HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n'
    ),
    Buffer.from('helloXX'),
    Buffer.from('0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, __proto__ header rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
__proto__: polluted\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, constructor header rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
constructor: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, prototype header rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
prototype: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, duplicate headers combined with comma', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
X-Forwarded-For: 1.1.1.1\r
X-Forwarded-For: 2.2.2.2\r
\r
`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers['x-forwarded-for'], '1.1.1.1, 2.2.2.2')
})

test('request, stacked transfer-encoding with chunked last', (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: gzip, chunked\r
\r
5\r
hello\r
0\r
\r\n`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('request, stacked transfer-encoding without chunked last', (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: example.com\r
Transfer-Encoding: chunked, gzip\r
Content-Length: 5\r
\r
hello`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('request, separator chars rejected in header name', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
X[Bad]: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, parentheses rejected in header name', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
X(Bad): value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, at-sign rejected in header name', async (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.1\r
Host: example.com\r
X@Bad: value\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('request, max headers count boundary', (t) => {
  const parser = new HTTPParser({ maxHeadersCount: 3 })

  const input = `GET /users HTTP/1.0\r
X-A: 1\r
X-B: 2\r
X-C: 3\r
\r
`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers['x-a'], '1')
  t.is(result[0].headers['x-b'], '2')
  t.is(result[0].headers['x-c'], '3')
})

test('request, max headers count exceeded by one', async (t) => {
  const parser = new HTTPParser({ maxHeadersCount: 3 })

  const input = `GET /users HTTP/1.0\r
X-A: 1\r
X-B: 2\r
X-C: 3\r
X-D: 4\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, header value trailing whitespace trimmed', (t) => {
  const parser = new HTTPParser()

  const input = `GET /users HTTP/1.0\r
X-Foo: bar   \r
X-Tab: baz\t\t\r
\r
`

  const result = [...parser.push(input)]

  t.is(result[0].type, REQUEST)
  t.is(result[0].headers['x-foo'], 'bar')
  t.is(result[0].headers['x-tab'], 'baz')
})

test('request, control character in method rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GE'),
    Buffer.from([0x01]),
    Buffer.from('T / HTTP/1.0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, null byte in url rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /us'),
    Buffer.from([0x00]),
    Buffer.from('ers HTTP/1.0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, control character in url rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET /us'),
    Buffer.from([0x01]),
    Buffer.from('ers HTTP/1.0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, control character in reason phrase rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('HTTP/1.1 200 O'),
    Buffer.from([0x00]),
    Buffer.from('K\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, duplicate host header rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `POST /users HTTP/1.1\r
Host: a.com\r
Host: b.com\r
Content-Length: 0\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID_HEADER/)
})

test('chunked response, chunk extension accepted', (t) => {
  const parser = new HTTPParser()

  const input =
    'HTTP/1.1 200 OK\r\n' +
    'Host: example.com\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    '\r\n' +
    '5;name=value\r\n' +
    'hello\r\n' +
    '0;final\r\n' +
    '\r\n'

  const result = [...parser.push(input)]

  t.is(result[0].type, RESPONSE)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('chunked response, chunk extension with quoted value', (t) => {
  const parser = new HTTPParser()

  const input =
    'HTTP/1.1 200 OK\r\n' +
    'Host: example.com\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    '\r\n' +
    '5;name="value"\r\n' +
    'hello\r\n' +
    '0\r\n' +
    '\r\n'

  const result = [...parser.push(input)]

  t.is(result[0].type, RESPONSE)
  t.is(result[1].type, DATA)
  t.alike(result[1].data, Buffer.from('hello'))
  t.is(result[2].type, END)
})

test('chunked response, chunk extension with control character rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from(
      'HTTP/1.1 200 OK\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n5;name='
    ),
    Buffer.from([0x00]),
    Buffer.from('\r\nhello\r\n0\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID_CHUNK_LENGTH/)
})

test('request, slash in method name rejected', async (t) => {
  const parser = new HTTPParser()

  const input = 'G/T / HTTP/1.0\r\n\r\n'

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, slash only allowed after HTTP in first token', (t) => {
  const parser = new HTTPParser()

  const input = 'HTTP/1.1 200 OK\r\nHost: example.com\r\n\r\n'

  const result = [...parser.push(input)]

  t.is(result[0].type, RESPONSE)
  t.is(result[0].version, 'HTTP/1.1')
  t.is(result[0].code, 200)
})

test('chunked response, chunk extension exceeds header size limit', async (t) => {
  const parser = new HTTPParser({ maxHeaderSize: 64 })

  const input =
    'HTTP/1.1 200 OK\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    '\r\n' +
    '5;' +
    'x'.repeat(100) +
    '\r\n' +
    'hello\r\n' +
    '0\r\n' +
    '\r\n'

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, invalid version rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/2.0 200 OK\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('response, HTTP/0.9 rejected', async (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/0.9 200 OK\r
\r
`

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('request, control character in version rejected', async (t) => {
  const parser = new HTTPParser()

  const input = Buffer.concat([
    Buffer.from('GET / HTTP/1'),
    Buffer.from([0x01]),
    Buffer.from('1\r\n\r\n')
  ])

  await t.exception(() => [...parser.push(input)], /INVALID/)
})

test('end, returns empty after full consumption', (t) => {
  const parser = new HTTPParser()

  const input = 'GET / HTTP/1.0\r\n\r\n'
  const result = [...parser.push(input)]

  t.is(result.length, 2)
  t.is(result[0].type, REQUEST)
  t.is(result[1].type, END)

  const remaining = parser.end()
  t.alike(remaining, Buffer.alloc(0))
})

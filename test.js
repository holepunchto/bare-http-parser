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

  const results = [...parser.push(input)]

  t.is(results[0].type, REQUEST)
  t.is(results[1].type, DATA)
  t.alike(results[1].data, Buffer.from('hello'))
  t.is(results[2].type, END)
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

  const results = [...parser.push(input)]

  t.is(results[0].type, REQUEST)
  t.is(results[0].headers.host, 'example.com')
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

    const results = [
      ...parser.push(Buffer.from(head + terminator.slice(0, i))),
      ...parser.push(Buffer.from(terminator.slice(i)))
    ]

    t.is(results[0].type, REQUEST)
    t.is(results[0].headers['x-foo'], 'bar')
  }
})

test('request, partial terminator match resets across pushes', (t) => {
  const parser = new HTTPParser()

  const results = [
    ...parser.push(Buffer.from('GET / HTTP/1.0\r\n')),
    ...parser.push(Buffer.from('X-Foo: bar\r\n')),
    ...parser.push(Buffer.from('\r\n'))
  ]

  t.is(results[0].type, REQUEST)
  t.is(results[0].headers['x-foo'], 'bar')
})

test('request, header size exceeded across multiple pushes', async (t) => {
  const parser = new HTTPParser({ maxHeaderSize: 64 })

  const results = []

  for (const msg of parser.push(Buffer.from('GET / HTTP/1.0\r\n'))) {
    results.push(msg)
  }

  for (const msg of parser.push(Buffer.from('X-A: value\r\n'))) {
    results.push(msg)
  }

  await t.exception(() => {
    for (const msg of parser.push(Buffer.from('X-Pad: ' + 'A'.repeat(30) + '\r\n\r\n'))) {
      results.push(msg)
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

  const results = []
  for (let i = 0; i < input.byteLength; i++) {
    for (const msg of parser.push(input.subarray(i, i + 1))) {
      results.push(msg)
    }
  }

  t.is(results[0].type, REQUEST)
  t.is(results[0].method, 'POST')
  t.is(results[results.length - 1].type, END)

  const body = Buffer.concat(results.filter((m) => m.type === DATA).map((m) => m.data))
  t.alike(body, Buffer.from('hello'))
})

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

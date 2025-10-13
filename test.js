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

test('response', (t) => {
  const parser = new HTTPParser()

  const input = `HTTP/1.1 201 Created\r
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

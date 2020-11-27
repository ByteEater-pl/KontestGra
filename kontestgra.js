"use strict"
const
  {db, adminPass} = require("./config"),
// Investigate possibility of switching to ES modules.
// May require newer Node.js (which couldn't be installed on Kontestacja's server).
  crypto = require("crypto"),
  handlers = conn => ({
    async login({user, pass, signup}) {
      await toPromise(conn, "beginTransaction")
// To refactor: call this from getQuestion and attempt.
      const [row] = await toPromise(conn, "query",
        "SELECT id, saltPassHash, salt FROM user WHERE name = ?", user)
      if (signup && !row) {
        await addUser(conn, user, pass[0])
        await toPromise(conn, "query",
          `INSERT INTO progress
            (SELECT id, 1, 0 FROM user WHERE id NOT IN
              (SELECT user FROM progress))`)
      }
      await toPromise(conn, "commit")
      return row ?
        !signup && crypto.scryptSync(pass[0], row.salt, 7).equals(row.saltPassHash)
        : !!signup
     },
    async getQuestion({user, pass, game, logged}) {
console.log({user, pass, game, logged})
      const [row] = logged ?
        await toPromise(conn, "query",
          "SELECT id, saltPassHash, salt FROM user WHERE name = ?", user) : [] // hurried, to refactor
console.log(row)
      return logged ?
        !!row && crypto.scryptSync(pass[0], row.salt, 7).equals(row.saltPassHash)
          && await toPromise(conn, "query",
            `SELECT text FROM question, progress
              WHERE gameId = game AND game = ? AND ord = question AND user =`
            + row.id, +game)
        : await toPromise(conn, "query",
          "SELECT text FROM question WHERE ord = 0 AND gameId =" + game)
    },
    async attempt({user, pass, game, answer, logged}) {
      const [row] = logged ? await toPromise(conn, "query",
        "SELECT id, saltPassHash, salt FROM user WHERE name = ?", user) : [] // hurried, to refactor
      if (!logged || row && crypto.scryptSync(pass[0], row.salt, 7).equals(row.saltPassHash)) {
        await toPromise(conn, "beginTransaction")
        const
          template = await toPromise(conn, "query", (logged ?
            `SELECT answer.text, misspellings FROM answer, question, progress
              WHERE questionId = question.id
                AND gameId = game
                AND ord = question
                AND user = ${row.id}
                AND game =`
            : `SELECT answer.text, misspellings FROM answer, question
              WHERE questionId = question.id AND ord = 1 AND gameId =`) + game),
          ansN = normalize(answer[0])
        let
          closest = null,
          acc = Infinity
        for (const {text, misspellings} of template) {
          const dist = levenshteinDistance(ansN, normalize(text))
          if (dist < Math.min(misspellings + 1, acc))
            [closest, acc] = [text, dist]
        }
        if (+logged && closest >= "") await toPromise(conn, "query",
          `UPDATE progress SET question = question + 1
            WHERE user = ${row.id} AND game = ?`, +game)
        await toPromise(conn, "commit")
        return {closest}
      }
      return false
    },
    async load({pass}) {
      return pass == adminPass && {
        users: await toPromise(conn, "query",
          "SELECT id, name FROM user ORDER BY name"),
        questions: await toPromise(conn, "query",
          "SELECT id, text, gameId FROM question ORDER BY gameId, ord"),
        answers: await toPromise(conn, "query",
          "SELECT text, misspellings, questionId FROM answer ORDER BY id")
      }
    },
    async save(data) {
// To refactor: destructure with {0: Identifier} instead of using || [].
      if (data.pass != adminPass) return false

      await toPromise(conn, "beginTransaction")

      const
        uIds = data.user_id || [],
        start = uIds.indexOf(""),
        added = start < 0 ? [] : uIds.splice(start, Infinity),
        stay = [],
        out = [],
        missingPass = []

      function addUser_i(index) {
        return addUser(conn, data.user_name[index], data.user_pass[index])
      }

      for (const {id} of await toPromise(conn, "query",
        "SELECT id FROM user"))
        (uIds.includes(`${id}`) ? stay : out).push(id)
      if (out.length) await toPromise(conn, "query",
        `DELETE FROM user WHERE id IN (${out.join()})`)
      for (const [i, id, pass = data.user_pass[i]]
        of uIds.entries())
        await (stay.includes(+id)
          ? toPromise(conn, "query",
            `UPDATE user SET name = ?
              ${pass && ", saltPassHash = ?, salt = ?"}
              WHERE id =` + id,
            [data.user_name[i], ... pass && salt(pass)])
          : pass ? addUser_i(i) : missingPass.push(id))
      for (const i in added) await addUser_i(start + +i)
// Temporary initialization for the time being with only 1 game.
// Eventually should be done when the user joins a game.
      await toPromise(conn, "query",
        `INSERT INTO progress
          (SELECT id, 1, 0 FROM user WHERE id NOT IN
            (SELECT user FROM progress))`)

      await toPromise(conn, "query",
        "DELETE FROM question")
      for (const [i, id] of (data.question_id || []).entries())
        await toPromise(conn, "query",
          `INSERT INTO question VALUES (?, ?, ?, ?)`,
            [id, i, data.question_text[i], data.question_gameId[i]])

      await toPromise(conn, "query",
        "DELETE FROM answer")
      for (const [i, text] of (data.answer_text || []).entries())
        await toPromise(conn, "query",
          "INSERT INTO answer VALUES (?, ?, ?, ?)",
          [i, text, data.answer_misspellings[i], data.answer_questionId[i]])

      await toPromise(conn, "commit")
      return missingPass
    }
  })

function addUser(conn, name, pass) {
  return toPromise(conn, "query",
    "INSERT INTO user VALUES (DEFAULT, ?, ?, ?)", [name, ...salt(pass)])
}

function salt(pass) {
  const salt = crypto.randomBytes(9).toString('base64')
  return [crypto.scryptSync(pass, salt, 7), salt]
}

function normalize(s) {
  return s.normalize("NFKD").replace(/\W/g, "").toLowerCase()
}

function levenshteinDistance(a, b) {
  if (a.length > b.length) [a, b] = [b, a]
  let curr = [...Array(a.length + 1).keys()]
  for (let i = 0; i < b.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < a.length; j++)
      next.push(Math.min(
        next[j] + 1,
        curr[j + 1] + 1,
        curr[j] + (a[j] != b[i])
      ))
    curr = next
  }
  return curr.pop()
}

function toPromise(obj, meth, ...args) {
  return new Promise((resolve, reject) =>
    obj[meth].call(obj, ...args, (err, result) =>
      err ? reject(err) : resolve(result)))
}

require("http").createServer(async (req, res) => {
  let conn
  try {
    const fields = await toPromise(new (require('multiparty')).Form, "parse", req)
    conn = require("mysql").createConnection(db)
    const body = await handlers(conn)[decodeURI(req.url).slice(1)](fields)
    res.writeHead(200, {"Content-Type": "application/json"})
// The end call can be chained starting from Node.js 11.10.0 – change when upgraded.
    res.end(JSON.stringify(body))
  }
  catch(e) {
    console.log(e)
    res.writeHead(400, {"Content-Type": "text/plain"})
    res.end("Request could not be successfully processed.")
  }
  finally { if (conn) conn.end() }
}).listen(8080, "localhost")
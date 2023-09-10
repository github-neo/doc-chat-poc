import { Document } from "langchain/document";
import { CharacterTextSplitter } from "langchain/text_splitter";
// import { Database } from "sqlite3";
import Database from "better-sqlite3";
import * as sqlite_vss from "sqlite-vss";
import { Config } from './config.mjs'
import pkg from 'express';
const { Express, Request, Response } = pkg;
import { sampleEmbedding } from './constant.mjs'
const db = new Database("chat-doc.db");



sqlite_vss.load(db);

// https://observablehq.com/@asg017/introducing-sqlite-vss

// db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
// db.exec(`DROP TABLE IF EXISTS chat_content`);
db.exec(
  `create table IF NOT EXISTS chat_content(
    content text,
    content_embedding TEXT
  );`
)

db.exec(
  `create virtual table IF NOT EXISTS vss_chat_content using vss0(
    content_embedding(1536)
  );`
)
// db.prepare(`DELETE FROM chat_content`).run();
// db.prepare(`delete from vss_chat_content`).run();

const sampleContent = 'The food was delicious and the waiter...';
const row = db.prepare('SELECT rowid, * FROM chat_content WHERE content = ?').get(sampleContent);
const vss_chat_content = db.prepare(`SELECT rowid, content_embedding FROM vss_chat_content`).all();
// not exsit
if (!row) {
  const result = db.prepare('INSERT INTO chat_content (content, content_embedding) VALUES (?, ?)').run(sampleContent, JSON.stringify(sampleEmbedding));
  const result2 = db.prepare('INSERT INTO vss_chat_content (rowid, content_embedding) VALUES (?, ?)').run(1, JSON.stringify(sampleEmbedding));
  console.log(result);
  console.log(result2);
}
const row2 = db.prepare('SELECT rowid, * FROM chat_content').all()
const vss_chat_content2 = db.prepare(`SELECT rowid, content_embedding FROM vss_chat_content`).all();
console.log('-------------', row2.map(item => item.rowid));
console.log(vss_chat_content2.map(item => item.rowid));

// const tables = db.prepare(
//   `SELECT * FROM sqlite_master
// WHERE type='table'`
// ).all();

// console.log(tables);

/**
 * 
 * @param {import("express").Request} req 
 * @param {import("express").Response} res 
 * @returns 
 */
export async function embeddings(
  req,
  res,
) {
  const raw = req.body.raw;
  if (!raw) {
    res.status(400).json({
      message: "raw can't be null",
    });
    return;
  }

  // https://js.langchain.com/docs/modules/data_connection/document_transformers/text_splitters/character_text_splitter

  // split by "\n\n"
  const splitter = new CharacterTextSplitter({
    separator: "\r\n\r\n",
    chunkSize: 500,
    chunkOverlap: 10,
  });
  const output = await splitter.createDocuments([raw]);
  // console.dir(output, { depth: 5 });
  // console.dir(output.length);

  const contents = output.map(doc => doc.pageContent);

  const embedding = (await createOpenaiEmbeddings(contents)).map(JSON.stringify)

  // call openai embeddings

  const chat_content = db.prepare('INSERT INTO chat_content (content, content_embedding) VALUES (?, ?)');
  const vss_chat_content = db.prepare(`
  INSERT INTO vss_chat_content (rowid, content_embedding)
    select rowid, content_embedding 
    from chat_content
    where content_embedding IN (${embedding.map(() => '?').join(',')})`);
  const insertChatContentEmbedding = db.transaction((embedding) => {
    vss_chat_content.run(embedding);
  });


  const insertChatContent = db.transaction((obj) => {
    for (let index = 0; index < obj.embedding.length; index++) {
      chat_content.run(obj.contents[index], obj.embedding[index])
    }
    // insert into vss table
    insertChatContentEmbedding(obj.embedding)
  });

  insertChatContent({
    embedding,
    contents
  })

  res.json({
    embedding,
    contents
  });
}

export async function embeddingsLookup(
  req,
  res,
) {
  const raw = req.body.raw;
  if (!raw) {
    res.status(400).json({
      message: "raw can't be null",
    });
    return;
  }

  const resp = await createOpenaiEmbeddings(raw);
  console.log(resp[0]);
  const tables = db.prepare(
    `
with matches as (
  select
    rowid,
    distance
  from vss_chat_content
  where vss_search(content_embedding, json('${JSON.stringify(resp[0])}'))
  limit 3
)
select
  chat_content.rowid,
  chat_content.content,
  matches.distance
from matches
left join chat_content on chat_content.rowid = matches.rowid 
  `
  ).all();

  console.log(tables);

  res.json(tables);
}


/**
 * 
 * @param {string | string[]} content 
 * @returns  {Promise<number[][]>}
 */
async function createOpenaiEmbeddings(content) {

  console.log('--------------------------', Config.OPENAI_KEY);
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: 'POST',
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Config.OPENAI_KEY}`
    },
    body: JSON.stringify({
      input: content,
      model: "text-embedding-ada-002"
    })
  });
  const embeddingsBody = await resp.json();
  console.log(embeddingsBody);
  console.log("usage", embeddingsBody.usage);
  return embeddingsBody.data.map(item => item.embedding)


}


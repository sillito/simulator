//
// Convert service.js logs (read from stdin) to a CSV file (written to stdout). 
//
const process = require("process")
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
})

const header = ["request_id"]
const rows = []

readline.on('line', (line) => {
    let metrics = JSON.parse(line)
    let row = []
    Object.keys(metrics).forEach((k) => {
        if (header.indexOf(k) < 0) {
            header.push(k)
        }
        
        row[header.indexOf(k)] = metrics[k]
    })

    for (let i = 0; i<header.length; i++) {
        if (row[i] === undefined)
            row[i] = ''
    }
    
    rows.push(row)
})

readline.on('close', () => {
    console.log(header.join(','))
    for (let row in rows) {
        console.log(rows[row].join(','))
    }
})

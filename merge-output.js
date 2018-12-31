//
// Combine multiple csv files into one. Note this makes strong assumptions 
// about the format of the csv files, so it is pretty fragile atm (TODO).
//
// USAGE: node merge-output.js [csv files]
//
const process = require("process")
const fs = require('fs')

const header = ["request id"]
const rows = [] // indexed by request_id

process.argv.slice(2).forEach((file_name) => {
    let base_name = file_name.split('/').slice(-1)[0].split('.')[0]
    header.push(`${base_name} status`, `${base_name} time`)
    
    let lines = fs.readFileSync(file_name).toString().split("\n")
    lines.forEach((line) => {
        let items = line.split(',').map(Number)
        if (!rows[items[0]])
            rows[items[0]] = []
            
        rows[items[0]].push(...items.slice(1))
    })
})

console.log(header.join(','))

rows.forEach((row, index) => {
    if (row.length > 1) {
        console.log(`${index},${row.join(',')}`)
    }
})

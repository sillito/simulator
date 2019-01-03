#!/bin/bash
#
# Sample script to setup and run an experiment
#

#
# create a directory to save experiment ouptput
#
DIR=base-line-`date +%F`
mkdir $DIR
cat $0 > $DIR/experiment.config # the config is this script
echo [Saving experiment output to $DIR/]

#
# Start two services s0 and s1, with s0 calling s1
#
echo [Starting services]
node service.js --port 3000 --type serial --services http://127.0.0.1:3001 > $DIR/s0.metrics &
node service.js --port 3001 --type timed --failure_rate 0.5 > $DIR/s1.metrics &

sleep 2 # give services time to start up, before running the experiment

#
# Use ab command to execute the experiment
#
echo [Running experiment]
ab -l -n 100 -c 10 -e $DIR/ab.csv http://127.0.0.1:3000/ > $DIR/ab.output

#
# convert the metrics logs to csv files
#
echo [Processing experiment logs]
# grep server_side_time $DIR/s0.metrics | node convert-logs-to-csv.js > $DIR/s0-server-metrics.csv
# grep client_side_time $DIR/s0.metrics | node convert-logs-to-csv.js > $DIR/s0-client-metrics.csv
# grep server_side_time $DIR/s1.metrics | node convert-logs-to-csv.js > $DIR/s1-server-metrics.csv
node summarize-mertics.js < $DIR/s0.metrics 

#
# clean up all of the child processes started by this script
#
echo [Cleaning up child processes]
pkill -P $$

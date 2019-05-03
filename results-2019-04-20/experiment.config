#!/bin/bash
#
# Sample script to setup and run an experiment
#

#
# create a directory to save experiment ouptput
#
DIR=results-`date +%F`
mkdir -p $DIR
cat $0 > $DIR/experiment.config # the config is this script
echo [Saving experiment output to $DIR/]

#
# Start four services; the last three all call the first one 
#
echo [Starting services]
node ./dist/service.js --config ../config/bork.json > $DIR/s0.metrics &
node ./dist/service.js --config ../config/s1.json > $DIR/s1.metrics &
node ./dist/service.js --config ../config/s2.json > $DIR/s2.metrics &


sleep 2 # give services time to start up before running the experiment

#
# Use ab command to execute the experiment
#
echo [Running experiment]
wrk -t 2 -c 100 -d 15s -R 300 --timeout 15s -L http://127.0.0.1:3001/ > $DIR/wk1.output
wrk -t 2 -c 100 -d 15s -R 300 --timeout 15s -L http://127.0.0.1:3002/ > $DIR/wk2.output

#
# convert the metrics logs to csv files
#
echo [Processing experiment logs]
node summarize-metrics.js --trial 1 < $DIR/s1.metrics 
node summarize-metrics.js --trial 2 < $DIR/s2.metrics 


#
# clean up all of the child processes started by this script
#
echo [Cleaning up child processes]
pkill -P $$

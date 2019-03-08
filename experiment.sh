#!/bin/bash
#
# Sample script to setup and run an experiment
#

#
# create a directory to save experiment ouptput
#
DIR=exp-`date +%F`
mkdir $DIR
cat $0 > $DIR/experiment.config # the config is this script
echo [Saving experiment output to $DIR/]

#
# Start four services; the last three all call the first one 
#
echo [Starting services]
node service.js --name Bork --port 3000 --type timed --failure_rate 0.5 > $DIR/s0.metrics &
node service.js --name s1 --port 3001 --type serial --max_tries 1 --timeout 1000 --services http://127.0.0.1:3000 > $DIR/s1.metrics &
node service.js --name s2 --port 3002 --type serial --max_tries 5 --timeout 100 --services http://127.0.0.1:3000 > $DIR/s2.metrics &
node service.js --name s3 --port 3003 --type serial --max_tries 1 --timeout 300 --cache_hit_rate 0.5 --services http://127.0.0.1:3000 > $DIR/s3.metrics &

sleep 2 # give services time to start up before running the experiment

#
# Use ab command to execute the experiment
#
echo [Running experiment]
ab -l -k -n 2000 -c 2000 -e $DIR/ab.csv http://10.90.2.44:3001/ > $DIR/ab1.output

#
# convert the metrics logs to csv files
#
echo [Processing experiment logs]
node summarize-metrics.js --trial 1 < $DIR/s1.metrics 
node summarize-metrics.js --trial 2 < $DIR/s2.metrics 
node summarize-metrics.js --trial 3 < $DIR/s3.metrics 

#
# clean up all of the child processes started by this script
#
echo [Cleaning up child processes]
pkill -P $$

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
node service.js --port 3000 --type timed --failure_rate 0.5 > $DIR/s0.metrics &
node service.js --port 3001 --type serial --max_tries 1 --timeout 1000 --services http://127.0.0.1:3000 > $DIR/s1.metrics &
node service.js --port 3002 --type serial --max_tries 5 --timeout 100 --services http://127.0.0.1:3000 > $DIR/s2.metrics &
node service.js --port 3003 --type serial --max_tries 2 --timeout 300 --services http://127.0.0.1:3000 > $DIR/s3.metrics &

sleep 2 # give services time to start up before running the experiment

#
# Use ab command to execute the experiment
#
echo [Running experiment]
ab -l -n 100 -c 20 -e $DIR/ab.csv http://127.0.0.1:3001/ > $DIR/ab1.output
ab -l -n 100 -c 20 -e $DIR/ab.csv http://127.0.0.1:3002/ > $DIR/ab2.output
ab -l -n 100 -c 20 -e $DIR/ab.csv http://127.0.0.1:3003/ > $DIR/ab3.output

#
# convert the metrics logs to csv files
#
echo [Processing experiment logs]
node summarize-mertics.js --trial 1 --csv --header < $DIR/s1.metrics 
node summarize-mertics.js --trial 2 --csv < $DIR/s2.metrics 
node summarize-mertics.js --trial 3 --csv < $DIR/s3.metrics 

#
# clean up all of the child processes started by this script
#
echo [Cleaning up child processes]
pkill -P $$

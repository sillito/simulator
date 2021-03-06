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
#node ./dist/service.js --config ../config/bork.json > $DIR/s0.metrics &
#node ./dist/service.js --config ../config/bork2.json > $DIR/s01.metrics &
#node ./dist/service.js --config ../config/s1.json > $DIR/s1.metrics &
#node ./dist/service.js --config ../config/s2.json > $DIR/s2.metrics &
node ./dist/service.js --config ../config/ProductPage.service.json > $DIR/ProductPage.metrics &
node ./dist/service.js --config ../config/ProductPage1.service.json > $DIR/ProductPage1.metrics &
node ./dist/service.js --config ../config/CustomerReviews.json > $DIR/CustomerReviews.metrics &
node ./dist/service.js --config ../config/ProductInformation.json > $DIR/ProductInformation.metrics &
node ./dist/service.js --config ../config/RecommendedProducts.json > $DIR/RecommendedProducts.metrics &
node ./dist/service.js --config ../config/RecommendedProductsPrime.service.json > $DIR/RecommendedProductsPrime.metrics &


sleep 2 # give services time to start up before running the experiment

#
# Use ab command to execute the experiment
#
echo [Running experiment]
wrk -t 2 -c 150 -d 15s -R 100 --timeout 15s -L http://127.0.0.1:3098/ > $DIR/wk1.output
wrk -t 2 -c 150 -d 15s -R 100 --timeout 15s -L http://127.0.0.1:3099/ > $DIR/wk2.output

#
# convert the metrics logs to csv files
#
echo [Processing experiment logs]
node summarize-metrics.js --trial 1 < $DIR/ProductPage.metrics 
node summarize-metrics.js --trial 2 < $DIR/ProductPage1.metrics 


#
# clean up all of the child processes started by this script
#
echo [Cleaning up child processes]
pkill -P $$

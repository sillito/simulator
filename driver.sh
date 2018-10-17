#!/bin/bash

if [ "$1" != "" ]; then
    count=$1
else
    count=10
fi

for i in `seq 1 $count`
do
    curl -I http://localhost:3000/ &
    #echo $i
done

wait

/**
* MPV - Fake implementation of nodejs child_process
* Throw error on spawn
*/ 
module.exports.spawn = function(){
  throw new Error('Not implemented in UB');
}
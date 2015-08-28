var express = require('express');
var bodyParser = require('body-parser');
var Datastore = require('nedb');
var db = new Datastore({ filename: __dirname + '/rest.db', autoload: true });
var keydb = new Datastore({ filename: __dirname + '/key.db', autoload: true });
var ipdb = new Datastore({ filename: __dirname + '/ipaddress.db', autoload: true });

//Initialize the IP address database if there is nothing in there
ipdb.count({}, function (err, count) {
  if (count == 0) {
    //Initialize the IPaddress db with a list of IP addresses
    for (var i=2; i < 101; i++) {
      ipdb.insert({ipaddress: '192.168.1.' + i});
    }
  }
});

var app = express();
app.use(bodyParser.json({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

//Server static files (web pages) from public sub folder
//This will be used to send any web app to web browser
app.use(express.static(__dirname + '/public'));

//Users for the api
//In the real world users will be authenticated from Active Directory etc.
var passwords = {
  john: 'johnsecret',
  joe: 'joesecret'
};

app.get('/login', function (req, res) {
  var encodedCreds = req.get('Authorization');
  if (encodedCreds != undefined) {
    //Get rid of the Basic prefix
    var array = encodedCreds.trim().split(' ');
    if (array[0].toUpperCase() == 'BASIC') {
      var creds = (new Buffer(array[1], 'base64')).toString();
      var array = creds.split(':');
      var userid = array[0];
      var password = array[1];
      if (passwords[userid] == password) {
        //User is authenticated, issue a key
        //Delete any existing key for this userid
        keydb.remove({user: userid});
        //Now save the new key with timestamp
        keydb.insert({user: userid, timestamp: (new Date()).getTime()}, function(err, newDoc) {
          res.json({token: newDoc._id});
        });
      }
      else {
        res.status(401).json({error: 'Authentication failed'});
      }
    }
    else {
      res.status(400).json({error: 'Only Basic authorization scheme is supported'});
    }
  }
  else {
    res.status(400).json({error: 'Must provide Authorization header with credentials in Basic scheme'});
  }
});

//Stuff to do for all requests coming to api
app.all('/api/*', function (req, res, next) {
  //All responses will be sent in JSON
  res.set('Content-Type','application/json');
  //Enable Cross Origin Resource Sharing (CORS)
  res.set('Access-Control-Allow-Origin', '*');

  //Check whether client is authorized to make requests in the api
  //Use the Token header value to authenticate
  var token = req.get('Token');
  if (token != undefined) {
    keydb.findOne({_id: token.trim()}, function (err, doc) {
      if (doc != null) { //token was found in the db
        //Check if token has expired by comparing timestamp
        var nowTime = (new Date()).getTime();
        if (nowTime - doc.timestamp > 1000*60*60) {
          //token has expired - delete it
          keydb.remove({_id: doc._id});
          res.status(401).json({error: 'Token has expired. Please use /login to obtain a new one'});
        }
        else {
          req.user = doc.user;
          next();
        }
      }
      else {
        res.status(401).json({error: 'The provided token is not valid. Please use /login to obtain a new token'});
      }
    });
  }
  else {
    res.status(401).json({error: 'Must provide access token in Token header'});
  }
});

app.get('/api/vms', function (req, res) {
  db.find({_owner: req.user}, function (err, docs) {
    var infoSubset = docs.map(function(vm) {return {id: vm._id, name: vm.name}});
    res.json(infoSubset);
  });
});

app.get('/api/ipaddresses', function (req, res) {
  //List all IP addresses reserved by this user
  ipdb.find({_owner: req.user}, function (err, docs) {
    //Only return id and IP address
    res.json(docs.map(function(ip) { return {id: ip._id, ipaddress: ip.ipaddress}}));
  });
});

app.get('/api/vm/:id', function (req, res) {
  db.findOne({_id:req.params.id, _owner:req.user}, function (err, doc) {
    if (doc != null) {
      res.json(doc);
    }
    else {
      res.status(404).json({error: 'No such virtual machine'});
    }
  });
});

app.get('/api/ipaddress/:id', function (req, res) {
  ipdb.findOne({_id:req.params.id, _owner:req.user}, function (err, doc) {
    if (doc != null) {
      res.json(doc);
    }
    else {
      res.status(404).json({error: 'No such IP address'});
    }
  });
});

app.put('/api/vm/:id', function (req, res) {
  var updatedDoc = {};
  if (req.body.name != undefined) updatedDoc.name = req.body.name;
  if (req.body.vcpu != undefined) updatedDoc.vcpu = req.body.vcpu;
  if (req.body.ram != undefined) updatedDoc.ram = req.body.ram;
  if (req.body.ip != undefined) updatedDoc.ip = req.body.ip;
  if (req.body.disk != undefined) updatedDoc.disk = req.body.disk;
  if (Object.keys(updatedDoc).length > 0) {
    db.update({_id:req.params.id, _owner: req.user}, {$set:updatedDoc}, {}, function (err, numUpdates) {
        if (numUpdates == 1) {
          res.json({result: 'Updated successfully'});
        }
        else {
          res.status(404).json({error: 'No such virtual machine'});
        }
    });
  }
  else {
    res.status(400).json({error: 'Must specify at least one virtual machine attribute to update'});
  }
});

app.delete('/api/vm/:id', function (req, res) {
  db.remove({_id:req.params.id, _owner: req.user}, {}, function (err, numRemoved) {
    if (numRemoved == 1) {
      res.json({result: 'Deleted successfully'});
    }
    else {
      res.status(404).json({error: 'No such virtual machine'});
    }
  });
});

app.delete('/api/ipaddress/:id', function (req, res) {
  ipdb.remove({_id:req.params.id, _owner: req.user}, {}, function (err, numRemoved) {
    if (numRemoved == 1) {
      res.json({result: 'Deleted successfully'});
    }
    else {
      res.status(404).json({error: 'No such IP address'});
    }
  });
});

app.post('/api/vms', function (req, res) {
  if (req.body.name && req.body.vcpu && req.body.ram && req.body.ip && req.body.disk) {
    req.body._type = 'vm';
    req.body._owner = req.user;
    db.insert(req.body, function(err, newDoc) {
      res.set('Location', '/api/vm/' + newDoc._id);
      res.status(201).json({id: newDoc._id});
    });
  }
  else {
    res.status(400).json({error: 'Must provide name, vcpu, ram, ip and disk; or incorrect Content-Type header'});
  }
});

app.get('/api/vms/search', function (req, res) {
  if (req.query.name) {
    db.findOne({_owner: req.user, name: req.query.name}, function (err, doc) {
      if (doc) res.json(doc);
      else { res.status(404).json({error: 'No virtual machines found matching ' + req.query.name}); }
    });
  }
  else {
    res.status(400).json({error: 'Must specify name as a query parameter to search GET /api/vms/search?name=myvm'});
  }
});

app.post('/api/ipaddresses', function (req, res) {
  //Find a free IP address
  ipdb.findOne({_owner: {$exists: false}}, function (err, doc) {
    if (doc != null) {
      ipdb.update({_id: doc._id}, {$set: {_owner: req.user}}, {}, function (err, updated) {
          if (updated == 1) {
            res.json({result: 'IP address ' + doc.ipaddress + ' has been allocated'})
          }
          else {
            res.status(500).json({error: 'Update failed'});
          }
      });
    }
    else {
      res.status(404).json({error: 'Unable to find a free IP address'});
    }
  });
});

var server = app.listen(8000, function () {
  var host = server.address().address;
  var port = server.address().port;

  console.log('Rest1 app version 1.2 listening at http://%s:%s', host, port);
});

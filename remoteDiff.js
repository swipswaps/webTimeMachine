"use strict";

const requestPromise = require('request-promise-native');
const xml2js = require('xml2js-es6-promise');
const fs = require('fs-extra');
const url = require('url');
const sanitize = require("sanitize-filename");
const execProcess = require("./exec_process.js");
const webshot = require("webshot");
const batch = require( 'batch-promise' );
const sharp = require( 'sharp');

class RemoteDiff{
  sanitizeOption(){
    return {replacement: "_"};
  }

  constructor(sitemap, options){
    let defaults = {
      version : 'Unnamed version',
      records_dir: __dirname+'/records/',
      remote: false,
      branch: false,
      verbose : false,
      batch: 3
    };
    this.options=Object.assign({}, defaults, options);
    this.sitemap=sitemap;
    this.version = options.version;
    this.remote = options.remote;
    let myUrl = url.parse(sitemap);
    this.domain = myUrl.hostname;
    this.branch = options.branch || this.domain;
    this.record_dir = options.records_dir+sanitize(this.domain, this.sanitizeOption)+'/';
    this.urls = [];
    fs.ensureDirSync(this.record_dir);
  }

  _santisizeName(urlPath){
    let myUrl = url.parse(urlPath);
    let res = sanitize(myUrl.path, this.sanitizeOption);
    if(res === "")res="index";
    return res;
  }

  _createRecord(url, data){
    return new Promise((resolve, reject)=>{
      this._createSnapshots(url, data)
        .then(msg=>{
          if(this.options.verbose) console.log(msg);
          fs.writeFile(this.record_dir+this._santisizeName(url)+".html", data, err=>{
            if(err) reject(err); else resolve(`response captured for ${url}`);
          });
        }).catch(e=>reject(e));
    });
  }

  _createSnapshots(url, content){
    let promises = [];
    let image_path = this.record_dir+this._santisizeName(url);
    let resolutions = {
      mobile: {
        screenSize: {width: 320, height: 480},
        shotSize: {width: 320, height: 'all'},
        userAgent: 'Mozilla/5.0 (iPhone; U; CPU iPhone OS 3_2 like Mac OS X; en-us) AppleWebKit/531.21.20 (KHTML, like Gecko) Mobile/7B298g'
      },
      tablet: {
        windowSize: {width: 768, height: 1024},
        shotSize: {width: 768, height: 'all'},
      },
      desktop: {
        windowSize: {width: 1024, height: 768},
        shotSize: {width: 1024, height: 'all'},
      }
    };

    Object.entries(resolutions).forEach(v=>{
      let resolution = v[0];
      let options = v[1];
      promises.push(new Promise((resolve, reject)=>{
        content = content || url;
        if(content) options.siteType='html';
        webshot(content || url, `${image_path}_${resolution}.png`, options,function(err) {
          if(err) reject(err);
          else {
            sharp(`${image_path}_${resolution}.png`)
              .jpeg()
              .toFile(`${image_path}_${resolution}.jpeg`)
              .then(_=>{
                fs.unlinkSync(`${image_path}_${resolution}.png`);
                resolve(`screen captured for ${url} on ${resolution}`);
              })
              .catch(e=>{
                if(e=="Error: Processed image is too large for the JPEG format"){
                  resolve(`Error: Unable to capture ${url} due to large size!`);  
                } else
                resolve(`Error! ${e}`);
              });
          }
        });
      }));
    });

    return Promise.all(promises);
  }

  _processUrlSet(urls){
    urls.forEach(url=>{
      this.urls.push(url)
    });
  }

  _processSiteMap(sitemap){
    return new Promise(resolve=>{
      requestPromise(sitemap)
        .then(body=>xml2js(body))
        .then(result=>{
          if(result.sitemapindex){
            let promises = [];
            let sitemaps = result.sitemapindex.sitemap.map(data=>data.loc[0]);
            sitemaps.forEach(entry=>promises.push(this._processSiteMap(entry)));
            Promise.all(promises).then(_=>resolve(this.urls));
          }
          if(result.urlset){
            let urls = result.urlset.url.map(entry=>entry.loc[0]);
            this._processUrlSet(urls);
            resolve(this.urls);
          }
        })
    });
  }

  _gitShellCommit(message){
    return new Promise((resolve, reject)=>{
      execProcess.result(`
        cd ${this.record_dir} 
        git config core.autocrlf false
        git init .
        git add . 
        git commit -m "${message}"`, function (err, response) {
        if (!err) {
          if (this.remote) this._gitPushRemote().then(msg => resolve(response + msg));
          else resolve(response);
        } else {
          reject(err);
        }
      }.bind(this));
    });
  }

  _gitPushRemote(){
    return new Promise((resolve, reject)=>{
      execProcess.result(`cd ${this.record_dir};
        if ! git remote | grep origin > /dev/null; then 
          git remote add origin ${this.remote};
        fi;
        git push origin master:${this.branch};
        `
        , function(err, response){
        if(!err){
          resolve(response);
        }else {
          resolve(err);
        }
      }.bind(this));
    });
  }

  processUrls(urls = [], batchSize = 3){
    return new Promise((batchResolve)=>{
      let promises = urls.map(url=>(resolve, reject)=>{
        requestPromise(url)
          .then(body=>{
            if(body){
              this._createRecord(url, body).then(msg=>{
                if(this.options.verbose) console.log(msg);
                resolve("Webshot saved for ", url);
              });
            }
          }, e=>{
            console.log('Url fetch Error',e.statusCode, url);
            resolve('Url fetch Error', url);
          });
      });

      batch(promises, batchSize).then(result=>batchResolve(result))
    });
  }

  processSitemap(){
    if(this.sitemap){
      return this._processSiteMap(this.sitemap)
        .then(urls=>this.processUrls(this.urls, this.options.batch))
        .then(_this=>this._gitShellCommit(this.options.version));
    }
  }

}

module.exports = RemoteDiff;

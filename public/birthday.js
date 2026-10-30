// Standalone birthday greeting page (/birthday/<signed token>), opened from the
// WhatsApp message the committee sends. The video is muted until the person
// taps once - browsers do not allow sound to start by itself.
(function () {
  "use strict";
  var vid = document.getElementById("vid");
  var play = document.getElementById("play");
  var who = document.getElementById("who");
  var token = decodeURIComponent((location.pathname.split("/")[2] || "").trim());
  fetch("/api/public/birthday/" + encodeURIComponent(token))
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (data) {
      who.textContent = data.name;
      document.getElementById("wish-ar").textContent = "ألف مبروك يا " + data.name + "! كل عام وأنت بخير";
      document.getElementById("wish-en").textContent = "Congratulations " + data.name + " — Happy Birthday!";
      document.title = "Happy Birthday " + data.name;
    })
    .catch(function () {
      who.parentNode.classList.add("hidden");
    });
  play.addEventListener("click", function () {
    vid.muted = false;
    vid.currentTime = 0;
    var p = vid.play();
    if (p && p.catch) p.catch(function () { vid.muted = true; var q = vid.play(); if (q && q.catch) q.catch(function () {}); });
    play.classList.add("hidden");
  });
  vid.addEventListener("click", function () { if (vid.muted) { vid.muted = false; play.classList.add("hidden"); } });
})();

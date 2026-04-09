const express = require('express');
const app = express();
app.use(express.static('public'));
app.use((req,res,next)=>{res.setHeader('Strict-Transport-Security','max-age=63072000; includeSubDomains; preload');next()});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('jorge-com on port ' + PORT));

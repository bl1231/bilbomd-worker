import nodemailer from 'nodemailer'
import hbs from 'nodemailer-express-handlebars'
import path from 'path'

const user = process.env.SENDMAIL_USER
const viewPath = path.resolve(__dirname, './templates/mailer/')

const transporter = nodemailer.createTransport({
  name: 'bl1231-local.als.lbl.gov',
  host: 'smtp-relay.gmail.com',
  port: 25,
  secure: false
})

const sendJobCompleteEmail = (
  email: string,
  url: string,
  jobid: string,
  title: string
) => {
  console.log('send job complete email')
  transporter.use(
    'compile',
    hbs({
      viewEngine: {
        extname: '.handlebars',
        defaultLayout: 'jobcomplete',
        layoutsDir: viewPath
      },
      viewPath,
      extName: '.handlebars'
    })
  )

  const mailOptions = {
    from: user,
    to: email,
    subject: `BilboMD Job Complete - Job Title: ${title}`,
    template: 'jobcomplete',
    context: {
      jobid,
      url,
      title
    }
  }

  transporter.sendMail(mailOptions).catch((err) => console.log(err))
}

export { sendJobCompleteEmail }

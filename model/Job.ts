
import { Document, Date, Schema, ObjectId, model } from "mongoose"

interface IBilboMDJob extends Document {
  title: string
  uuid: string
  psf_file: string
  crd_file: string
  const_inp_file: string
  data_file: string
  conformational_sampling: number
  rg_min: number
  rg_max: number
  status: string
  time_submitted: Date
  time_started: Date
  time_completed: Date
  user: ObjectId

}

const jobSchema = new Schema<IBilboMDJob>(
  {
    title: {
      type: String,
      required: true
    },
    uuid: { type: String, required: true },
    psf_file: { type: String, required: true },
    crd_file: { type: String, required: true },
    const_inp_file: { type: String },
    data_file: { type: String, required: true },
    conformational_sampling: {
      type: Number,
      enum: [1, 2, 3, 4],
      default: 1
    },
    rg_min: { type: Number, required: true, minimum: 10, maximum: 100 },
    rg_max: { type: Number, required: true, minimum: 10, maximum: 100 },
    status: {
      type: String,
      enum: ['Submitted', 'Pending', 'Running', 'Completed', 'Error'],
      default: 'Submitted'
    },
    time_submitted: { type: Date, default: new Date() },
    time_started: { type: Date },
    time_completed: { type: Date, default: new Date() },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  }
)

const Job = model<IBilboMDJob>('Job', jobSchema)

export { Job, IBilboMDJob }
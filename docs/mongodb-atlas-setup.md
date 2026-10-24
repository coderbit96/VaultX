# Connect VaultX to your own MongoDB Atlas database

VaultX can check a MongoDB connection now. It does not yet create vault accounts or store files. Keep your database password and full connection string on your computer; do not paste either into chat or commit them to Git.

## 1. Create an Atlas cluster

1. Open the official [MongoDB Atlas](https://www.mongodb.com/products/platform/atlas-database) website in your browser. Click **Try Free** or **Sign In**, then finish account verification.
2. In Atlas, create or select a **project** for VaultX. If this is your first cluster, Atlas may guide you through the project and cluster screens automatically.
3. In your project, click **Project Overview > Create**. Select **M0 / Free**, a cloud provider, and a nearby region. Name the cluster if you want, then click **Create**. Check that the selection says **Free** before confirming.
4. In the **Security Quickstart** wizard, make a separate **database user** with a strong generated password. Save the username and password in your password manager. This user is separate from your Atlas website login.
5. Click **Add My Current IP Address**, then **Finish and Close**. This allows connections from your current public IP. If your internet provider changes your IP later, update the entry in Atlas.

Atlas's current [free cluster walkthrough](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/) shows those screens. If you already have a project or cluster, start from the next section.

## 2. Limit database and network access

1. In Atlas, open **Security > Database & Network Access > Database Users**. Click **Add New Database User** if the quickstart did not create one. Choose **Password**, enter the username and password, and click **Add User**.
2. Give the VaultX application user only the access it needs. If the quickstart granted **Atlas Admin**, change that under **Database Users > Edit**. For a database-scoped role, open the **Custom Roles** tab, click **Add New Custom Role**, name it `vaultx_read_write`, select the `readWrite` role under **Database Actions and Roles**, enter `vaultx` as the **Database**, then click **Add Custom Role**. Edit the VaultX database user, assign this role under **Custom Roles**, remove any broader role, and save. If you have multiple clusters in one project, turn on **Restrict Access to Specific Clusters** and select the VaultX cluster. [MongoDB's custom-role instructions](https://www.mongodb.com/docs/atlas/security-add-mongodb-roles/) describe these controls.
3. Open **Security > Database & Network Access > IP Access List** (or **Network Access** in an older interface). Confirm the entry for **your current IP address**. Add your current IP there if missing. Do not add `0.0.0.0/0` or choose **Allow Access from Anywhere** for local development.
4. When you later deploy VaultX, add only the hosting service's known outbound IP address or use a supported private network connection. Your laptop's IP entry does not authorize a different server.

See MongoDB's [database-user](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/) and [IP access list](https://www.mongodb.com/docs/atlas/security/ip-access-list/) instructions for the latest Atlas labels.

## 3. Copy the URI into VaultX locally

1. In Atlas, open **Database > Clusters**. Click **Connect** on your VaultX cluster, then **Drivers**. Choose **Node.js** and copy the **connection string**. If a full code sample appears, turn off **View full code sample** first.
2. Replace the URI's `<password>` placeholder with the **database user's** password. If the password contains URI-special characters such as `@`, `:`, `/`, `?`, `#`, or `%`, [percent-encode them](https://www.mongodb.com/docs/atlas/driver-connection/#special-characters-in-connection-string-password) before inserting them. Do not use your Atlas website account password.
3. In VS Code, open the `D:\VaultX` folder. In the left Explorer, create a new file named `.env.local` in the **project root**, next to `package.json`. You can copy `.env.example` first and rename the copy.
4. Add these two lines, replacing the placeholder text on your own computer:

   ```dotenv
   MONGODB_URI=your-full-Atlas-connection-string
   MONGODB_DB_NAME=vaultx
   ```

5. Save with **Ctrl+S**. Keep `MONGODB_URI` on one line. Do not put it in a variable beginning with `NEXT_PUBLIC_`. `.env.local` is ignored by Git.

The database named `vaultx` does not need to be created manually for this connection check. It will be created when a future step first writes data. If you want to see it in Atlas now, click **Database > Data Explorer**, select or hover over your cluster in **Connections**, click the **Create Database** icon, enter `vaultx` for **Database Name** and `setup_check` for **Collection Name**, then click **Create Database**. That empty collection is optional and VaultX does not use it. See Atlas's [create database instructions](https://www.mongodb.com/docs/atlas/atlas-ui/databases/) and [Node.js connection guide](https://www.mongodb.com/docs/drivers/node/current/get-started/).

## 4. Check the connection

1. In VS Code, click **Terminal > New Terminal**.
2. Run `npm run db:check`. The successful result is **MongoDB connection OK. Atlas responded to ping.** This check reads configuration and pings the database; it does not create a collection or upload any files.
3. If it fails, check that the cluster is running, the database username and password are correct, the password is percent-encoded in the URI where needed, and your current public IP is in Atlas's IP access list. The command deliberately does not print the URI or the driver's raw error.
4. For an optional browser check, run `npm run dev`, then open `http://localhost:3000/api/health/database`. It shows only `{"status":"ok"}` or `{"status":"unavailable"}` in development. The endpoint returns 404 in production.

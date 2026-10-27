import {redirect, Form, useLoaderData} from 'react-router';

import {login} from '../../shopify.server';

import styles from './styles.module.css';

export const loader = async ({request}) => {
  const url = new URL(request.url);

  if (url.searchParams.get('shop')) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return {showForm: Boolean(login)};
};

export default function App() {
  const {showForm} = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Campaign performance dashboard</h1>
        <p className={styles.text}>
          Query a campaign’s sales with ShopifyQL, measure them against
          targets, and record the campaign on the store’s analytics timeline.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>For example, my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}

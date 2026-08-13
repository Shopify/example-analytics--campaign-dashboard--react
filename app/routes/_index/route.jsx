import {redirect, Form, useLoaderData} from 'react-router';

import {login} from '../../shopify.server';

import styles from './styles.module.css';

const SHOP_ERRORS = {
  MISSING_SHOP: 'Enter your store domain.',
  INVALID_SHOP: "That doesn't look like a store domain.",
};

export const loader = async ({request}) => {
  const url = new URL(request.url);

  if (url.searchParams.get('shop')) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // `/auth/login` sends a rejected domain back here rather than rendering a page of its
  // own.
  return {
    showForm: Boolean(login),
    error: SHOP_ERRORS[url.searchParams.get('shop_error')] ?? null,
  };
};

export default function App() {
  const {showForm, error} = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Campaign performance dashboard</h1>
        <p className={styles.text}>
          Report a campaign's funnel with App Events, query it back with
          ShopifyQL, and record the result on the store's analytics timeline.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            {error && <p className={styles.text}>{error}</p>}
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}
